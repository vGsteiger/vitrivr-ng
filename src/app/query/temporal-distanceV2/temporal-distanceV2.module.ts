import {NgModule} from '@angular/core';
import {CommonModule} from '@angular/common';
import {MaterialModule} from '../../material.module';
import {FlexLayoutModule} from '@angular/flex-layout';
import {FormsModule} from '@angular/forms';
import {TemporalDistanceV2Component} from './temporal-distanceV2.component';

@NgModule({
  declarations: [TemporalDistanceV2Component],
  imports: [
    CommonModule,
    MaterialModule,
    FlexLayoutModule,
    FormsModule
  ],
  exports: [
    TemporalDistanceV2Component
  ]
})
export class TemporalDistanceV2Module {
}
