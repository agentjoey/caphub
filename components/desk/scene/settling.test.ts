import { expect, it } from "vitest";
import { World, Body, Plane, Sphere, Box, Vec3 } from "cannon-es";
import { settleBody } from "./settling";
it("settles a spinning paper supported above the floor by the library pile", () => {
 const radius=.192;
 const world=new World({gravity:new Vec3(0,-7,0),allowSleep:true});
 const floor=new Body({mass:0,shape:new Plane()});floor.position.y=-.1;floor.quaternion.setFromEuler(-Math.PI/2,0,0);world.addBody(floor);
 const pile=new Body({mass:0,shape:new Box(new Vec3(.3,.05,.4))});pile.position.y=-.06;world.addBody(pile);
 const paper=new Body({mass:.16,shape:new Sphere(radius),position:new Vec3(0,1,0),allowSleep:true,sleepSpeedLimit:.018,sleepTimeLimit:.35});paper.angularVelocity.y=1;world.addBody(paper);
 let quiet=0;
 for(let i=0;i<720;i++){world.step(1/60);quiet=settleBody(paper,world.contacts,radius,quiet,1/60);}
 expect(paper.position.y).toBeGreaterThan(radius-.05);
 expect(paper.sleepState).toBe(Body.SLEEPING);
});
