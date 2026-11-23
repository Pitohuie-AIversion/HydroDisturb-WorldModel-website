/** Three coordinates of one illustrative token, independent of any CFD or checkpoint. */
export type Features = [number, number, number];
export const steps = 8;
export const stepSize = 1 / steps;
export const initial: Features = [.2, -.12, .1];

export function teachingVelocity(z: Features, tau: number, d = 0): Features {
  return [
    1 - .5 * z[0] + .25 * tau + .16 * d,
    1.7 * Math.cos(2 * Math.PI * tau) - .35 * z[1] - .12 * d,
    1.1 * Math.sin(2 * Math.PI * tau) - .25 * z[2] + .10 * d,
  ];
}

function advance(z: Features, v: Features, h: number): Features {
  return [z[0] + h*v[0], z[1] + h*v[1], z[2] + h*v[2]];
}

/** Construct the states by integrating the field, so geometry and arithmetic agree. */
export function ordinaryTrajectory() {
  const states = [initial];
  const velocities: Features[] = [];
  for (let k = 0; k < steps; k++) {
    const v = teachingVelocity(states[k], k*stepSize);
    velocities.push(v);
    states.push(advance(states[k], v, stepSize));
  }
  return {states, velocities};
}

export function shortcutExample() {
  const d = .25;
  const student = teachingVelocity(initial, 0, d);
  const half1 = teachingVelocity(initial, 0, d/2);
  const middle = advance(initial, half1, d/2);
  const half2 = teachingVelocity(middle, d/2, d/2);
  const target: Features = [(half1[0]+half2[0])/2, (half1[1]+half2[1])/2, (half1[2]+half2[2])/2];
  return {d, student, half1, half2, target};
}
