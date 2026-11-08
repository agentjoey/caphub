import { expect, it } from "vitest";
import { pileYaw, fitOpenBand, scatterPosition } from "./layout";
it("gives pile sheets and file targets the upright half turn with bounded jitter", () => {
 expect(pileYaw(0)).toBe(Math.PI);
 for (let i=0;i<30;i++) expect(Math.abs(pileYaw(i)-Math.PI)).toBeLessThanOrEqual(.22);
});
it("fits and centers the opened sheet between measured controls with 12px gaps", () => {
 const box=fitOpenBand({top:130,bottom:800},1440,840,1/1.414);
 expect(box.top).toBeGreaterThanOrEqual(142);
 expect(box.top+box.height).toBeLessThanOrEqual(788);
 expect(box.top+box.height/2).toBe(465);
 const mobile=fitOpenBand({top:180,bottom:700},390,780,1/1.414);
 expect(mobile.width).toBeLessThanOrEqual(351);
 expect(mobile.top).toBeGreaterThanOrEqual(192);
 expect(mobile.top+mobile.height).toBeLessThanOrEqual(688);
});
it("rejection-samples within the zone, outside the pile and separated from existing balls", () => {
 let seed=1; const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const existing: {x:number;z:number}[]=[];
 for(let i=0;i<10;i++) {
  const point=scatterPosition(false,.19,existing,{x:1.3,z:.95},random);
  expect(point.x).toBeGreaterThanOrEqual(-2);expect(point.x).toBeLessThanOrEqual(1.4);
  expect(point.z).toBeGreaterThanOrEqual(-.75);expect(point.z).toBeLessThanOrEqual(1.1);
  expect(Math.hypot(point.x-1.3,point.z-.95)).toBeGreaterThanOrEqual(.9);
  for(const old of existing)expect(Math.hypot(point.x-old.x,point.z-old.z)).toBeGreaterThanOrEqual(2.3*.19);
  existing.push(point);
 }
});
