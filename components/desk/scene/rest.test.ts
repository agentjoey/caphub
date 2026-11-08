import { expect, it } from "vitest";
import { isEverythingAtRest } from "./rest";
const settled = { state: "rest" as const, sleeping: true, animating: false, dropDelay: 0 };
it("stops for an empty desk, sleeping balls, an open sheet and completed exits", () => {
 expect(isEverythingAtRest([],false)).toBe(true);
 expect(isEverythingAtRest([settled,{...settled,state:"open",sleeping:false},{...settled,state:"gone",sleeping:false}],false)).toBe(true);
});
it("keeps rendering for physics, animation, dragging and staggered drops", () => {
 expect(isEverythingAtRest([settled],true)).toBe(false);
 for(const paper of [{...settled,sleeping:false},{...settled,animating:true},{...settled,dropDelay:.07},{...settled,state:"grab" as const}])expect(isEverythingAtRest([paper],false)).toBe(false);
});
