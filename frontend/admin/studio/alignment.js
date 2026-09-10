import {WIDTH,HEIGHT} from './model.js';

// Threshold is passed in document pixels, converted from preview pixels by UI.
export function snapPosition(position,other,threshold,{disabled=false}={}){
  const result={...position},guides={};
  if(disabled)return {position:result,guides};
  for(const [axis,center]of [['x',WIDTH/2],['y',HEIGHT/2]]){
    const targets=[center,other[axis]];
    const nearest=targets.reduce((best,value)=>Math.abs(value-position[axis])<Math.abs(best-position[axis])?value:best);
    if(Math.abs(nearest-position[axis])<=threshold){result[axis]=nearest;guides[axis]=nearest;}
  }
  return {position:result,guides};
}
