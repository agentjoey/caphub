import type { Body, ContactEquation } from "cannon-es";
/** Apply rolling resistance to any supporting contact, including the pile and other papers. */
export function settleBody(body: Body, contacts: ContactEquation[], radius: number, quiet: number, dt: number): number {
  const supported = body.position.y <= radius - .1 + .025 || contacts.some(contact =>
    (contact.bi === body && contact.ni.y < -.3) || (contact.bj === body && contact.ni.y > .3));
  if (supported) {
    body.velocity.scale(Math.exp(-2.6 * dt), body.velocity);
    body.angularVelocity.scale(Math.exp(-4.5 * dt), body.angularVelocity);
  }
  const settled = supported && body.velocity.length() < .018 && body.angularVelocity.length() < .06
    ? quiet + dt : 0;
  if (settled > .35) body.sleep();
  return settled;
}
