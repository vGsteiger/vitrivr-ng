import {Injectable} from '@angular/core';
import {SegmentScoreContainer} from '../../shared/model/results/scores/segment-score-container.model';
import {MetadataLookupService} from '../lookup/metadata-lookup.service';
import {VideoUtil} from '../../shared/util/video.util';
import {HttpClient, HttpHeaders, HttpParams} from '@angular/common/http';
import {ConfigService} from '../basics/config.service';
import {Observable, of, Subject, Subscription} from 'rxjs';
import {MatSnackBar} from '@angular/material';
import {Config} from '../../shared/model/config/config.model';
import {EventBusService} from '../basics/event-bus.service';
import {VbsInteractionLog} from './vbs-interaction-log.model';
import {bufferTime, catchError, debounceTime, filter, flatMap, map, tap} from 'rxjs/operators';
import {SelectionService} from '../selection/selection.service';
import {QueryService} from "../queries/query.service";
import {VbsInteraction} from "../../shared/model/vbs/interfaces/vbs-interaction.model";
import {VbsResultsLog} from "./vbs-results-log.model";

/**
 * This service is used to submit segments to VBS web-service for the Video Browser Showdown challenge. Furthermore, if
 * the VBS mode is active, it listens to events emmited on the EventBus and maps them to VbsActions
 */
@Injectable()
export class VbsSubmissionService {
    /** The observable used to react to changes to the Vitrivr NG configuration. */
    private _config: Observable<[string, string, number, boolean, number]>;

    /** The subject used to submit segments to the VBS service. */
    private _submitSubject = new Subject<[SegmentScoreContainer, number]>();

    /** Reference to the subscription that is used to issue submits to the VBS server. */
    private _submitSubscription: Subscription;

    /** Reference to the subscription that is used to submit updates to the results list. */
    private _resultsSubscription: Subscription;

    /** Reference to the subscription that is used to submit interaction logs on a regular basis to the VBS server. */
    private _interactionlogSubscription: Subscription;

    /** Reference to the subscription to the vitrivr NG configuration. */
    private _configSubscription: Subscription;

    /**
     * Constructor for VbsSubmissionService.
     *
     * @param {ConfigService} _config
     * @param {EventBusService} _eventbus Reference to the singleton EventBusService instance.
     * @param {QueryService} _queryService Reference to the singleton QueryService instance.
     * @param {SelectionService} _selection Reference to the singleton SelectionService instance.
     * @param {MetadataLookupService} _metadata
     * @param {HttpClient} _http
     * @param {MatSnackBar} _snackBar
     */
    constructor(_config: ConfigService,
                private _eventbus: EventBusService,
                private _queryService: QueryService,
                private _selection: SelectionService,
                private _metadata: MetadataLookupService,
                private _http: HttpClient,
                private _snackBar: MatSnackBar) {

        /* */
        this._config = _config.asObservable().pipe(
            filter(c => c.get<string>('vbs.endpoint') != null),
            map(c => <[string, string, number, boolean, number]>[c.get<string>('vbs.endpoint').endsWith('/') ? c.get<string>('vbs.endpoint').slice(0, -1) : c.get<string>('vbs.endpoint'), c.get<string>('vbs.teamid'), c.get<number>('vbs.toolid'), c.get<boolean>('vbs.log'), c.get<number>('vbs.loginterval')])
        );


        /* This subscription registers the event-mapping, recording and submission stream if the VBS mode is active and un-registers it, if it is switched off! */
        this._configSubscription = this._config.subscribe(([endpoint, team, tool, log,  loginterval]) => {
            if (endpoint && team) {
                this.reset(endpoint, team, tool, log, loginterval)
            } else {
                this.cleanup()
            }
        });
    }

    /**
     * Submits the provided SegmentScoreContainer and to the VBS endpoint. Uses the segment's start timestamp as timepoint.
     *
     * @param {SegmentScoreContainer} segment Segment which should be submitted. It is used to access the ID of the media object and to calculate the best-effort frame number.
     */
    public submitSegment(segment: SegmentScoreContainer) {
        this.submit(segment, (segment.startabs + segment.endabs) / 2);
    }

    /**
     * Submits the provided SegmentScoreContainer and the given time to the VBS endpoint.
     *
     * @param {SegmentScoreContainer} segment Segment which should be submitted. It is used to access the ID of the media object and to calculate the best-effort frame number.
     * @param number time The video timestamp to submit.
     */
    public submit(segment: SegmentScoreContainer, time: number) {
        this._submitSubject.next([segment, time]);
        this._selection.add(this._selection.availableTags[0], segment.segmentId);
    }

    /**
     * Resets the VBSSubmissionService, re-initiating all subscriptions.
     */
    public reset(endpoint: string, team: string, tool: number = 1, log: boolean = false, loginterval: number = 5000) {
        /* Run cleanup. */
        this.cleanup();

        /* Setup interaction log subscription, which runs in a regular interval. */
        if (log == true) {
          this._interactionlogSubscription = VbsInteractionLog.mapEventStream(this._eventbus.observable()).pipe(
            bufferTime(loginterval),
            map((events: VbsInteraction[], index: number) => {
              if (events && events.length > 0) {
                const iseq = new VbsInteractionLog(team, tool);
                iseq.events.push(...events);
                return iseq
              } else {
                return null
              }
            }),
            filter(log => log != null),
            flatMap((log: VbsInteractionLog) => {
              /* Prepare log submission. */
              const headers = new HttpHeaders().append('Content-Type', 'application/json');
              const params = new HttpParams().set('team', log.teamId).set('member', String(log.memberId));
              const observable = this._http.post(String(`${endpoint}/log`), JSON.stringify(log),{responseType: 'text', params: params, headers: headers});

              /* Do some logging and catch HTTP errors. */
              return observable.pipe(
                tap(o => console.log(`Submitting interaction log to VBS server.`)),
                catchError((err) => of(`Failed to submit segment to VBS due to a HTTP error (${err.status}).`))
              );
            })
          ).subscribe();

          /* Setup results subscription, which is triggered upon change to the resultset. */

          this._resultsSubscription = this._queryService.observable.pipe(
              filter(f => f === 'ENDED'),
              flatMap(f => this._queryService.results.segmentsAsObservable),
              debounceTime(1000), /* IMPORTANT: Limits the number of submissions to one per second. */
              map(r => {
                return VbsResultsLog.mapSegmentScoreContainer(team, tool, r)
              }),
              filter(log => log != null),
              flatMap((log: VbsResultsLog) => {
                /* Prepare log submission. */
                const headers = new HttpHeaders().append('Content-Type', 'application/json');
                const params = new HttpParams().set('team', log.teamId).set('member', String(log.memberId));
                const observable = this._http.post(String(`${endpoint}/log`), JSON.stringify(log),{responseType: 'text', params: params, headers: headers});

                /* Do some logging and catch HTTP errors. */
                return observable.pipe(
                  tap(o => console.log(`Submitting interaction log to VBS server.`)),
                  catchError((err) => of(`Failed to submit segment to VBS due to a HTTP error (${err.status}).`))
                );
              })
            ).subscribe();
        }

        /* Setup submission subscription, which is triggered manually. */
        this._submitSubscription = this._submitSubject.pipe(
              map(([segment, time]): [SegmentScoreContainer, number] => {
                  let fps = Number.parseFloat(segment.objectScoreContainer.metadataForKey('technical.fps'));
                  if (Number.isNaN(fps) || !Number.isFinite(fps)) {
                      fps = VideoUtil.bestEffortFPS(segment);
                  }
                  return [segment, VbsSubmissionService.timeToFrame(time, fps)]
              }),
              flatMap(([segment, frame]) => {
                  /* Prepare VBS submission. */
                  const videoId = parseInt(segment.objectId.replace('v_', '')).toString();
                  const params = new HttpParams().set('team', String(team)).set('member', String(tool)).set('video', videoId).set('frame', String(frame));
                  const observable = this._http.get(String(`${endpoint}/submit`), {responseType: 'text', params: params});

                  /* Do some logging and catch HTTP errors. */
                  return observable.pipe(
                      tap(o => console.log(`Submitting video to VBS server; id: ${videoId}, frame: ${frame}`)),
                      catchError((err) => of(`Failed to submit segment to VBS due to a HTTP error (${err.status}).`))
                  );
              }),
              map((msg: string) => {
                      console.log(msg);
                      if (msg.indexOf('Correct') > -1) {
                          return [msg, 'snackbar-success'];
                      } else if (msg.indexOf('Wrong') > -1) {
                          return [msg, 'snackbar-error'];
                      } else {
                          return [msg, 'snackbar-warning'];
                      }
                  }
              )
          ).subscribe(([msg, clazz]) => {
              this._snackBar.open(msg, null, {duration: Config.SNACKBAR_DURATION, panelClass: clazz});
          });
    }




    /**
     * Returns true uf VBS mode is active and properly configured (i.e. endpoint and team ID is specified).
     *
     * @return {boolean}
     */
    get isOn(): Observable<boolean> {
      return this._config.pipe(map(([endpoint, team]) => endpoint != null && team != null));
    }

    /**
     * Ends all the running subscriptions and cleans up the references.
     */
    private cleanup() {
      if (this._submitSubscription != null) {
        this._submitSubscription.unsubscribe();
        this._submitSubscription = null;
      }
      if (this._interactionlogSubscription != null) {
        this._interactionlogSubscription.unsubscribe();
        this._interactionlogSubscription = null;
      }
      if (this._resultsSubscription != null) {
        this._resultsSubscription.unsubscribe();
        this._interactionlogSubscription = null
      }
    }

    /**
     * Convenience method to transform the timestamp within a video into a frame index.
     *
     * @param {number} timestamp Timestamp within the video.
     * @param {number} fps The FPS of the video.
     */
    // tslint:disable-next-line:member-ordering
    private static timeToFrame(timestamp: number, fps: number) {
      return Math.floor(timestamp * fps);
    }
}
