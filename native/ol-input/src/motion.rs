//! How the pointer gets from where it is to where it was sent.
//!
//! A pointer that teleports is the single most common reason synthetic input
//! is ignored: hover menus never open, drag targets never arm, and tooltips
//! never appear, because the app was never told the pointer passed over them.
//! So every move is a path, sampled at a fixed tick, along a slightly curved
//! line that accelerates to a peak and decelerates into the target.
//!
//! The shape is a cubic Bezier and the timing is speed-based rather than
//! duration-based, which is what keeps a 60pt nudge and a 2000pt sweep feeling
//! like the same hand.

use std::time::Duration;

use crate::coords::ScreenPoint;

/// One sample every tick. 125Hz is about what a real mouse reports, and it is
/// the rate the visible cursor is sampled at, so the two stay in step.
pub const TICK: Duration = Duration::from_millis(8);

/// Below this the path IS the destination: sampling a 6pt hop into eight
/// events buys nothing and costs a frame of latency.
const DIRECT_DISTANCE: f64 = 12.0;

/// How long a glide takes, as `FLOOR_MS + RATE * distance^EXPONENT`, capped.
/// A sublinear law is what makes a short hop feel immediate and a sweep across
/// three displays still feel like one gesture rather than a journey.
const FLOOR_MS: f64 = 90.0;
const RATE: f64 = 1.2;
const EXPONENT: f64 = 0.75;
/// A pointer the user cannot take back is a hang, not an animation.
const MAX_MS: f64 = 700.0;

/// Perpendicular deflection, as a fraction of the distance travelled. Enough
/// to read as a hand rather than a ruler.
const ARC: f64 = 0.09;
/// ...but a fraction of a very long sweep is a detour, so it is capped.
const MAX_ARC: f64 = 90.0;

/// Where the control points sit along the straight line, as a fraction.
const HANDLE: f64 = 0.3;

/// How much of the glide stays linear. Pure smoothstep starts and ends at a
/// dead stop, which reads as hesitation; this keeps a floor under both ends
/// while the middle still accelerates.
const LINEAR_SHARE: f64 = 0.18;

fn smoothstep(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Fraction of the path covered by fraction `u` of the time.
fn eased(u: f64) -> f64 {
    LINEAR_SHARE * u.clamp(0.0, 1.0) + (1.0 - LINEAR_SHARE) * smoothstep(u)
}

fn bezier_at(p0: ScreenPoint, c1: ScreenPoint, c2: ScreenPoint, p3: ScreenPoint, t: f64) -> ScreenPoint {
    let u = 1.0 - t;
    let (uu, uuu) = (u * u, u * u * u);
    let (tt, ttt) = (t * t, t * t * t);
    ScreenPoint::new(
        uuu * p0.x + 3.0 * uu * t * c1.x + 3.0 * u * tt * c2.x + ttt * p3.x,
        uuu * p0.y + 3.0 * uu * t * c1.y + 3.0 * u * tt * c2.y + ttt * p3.y,
    )
}

/// How long the pointer should spend covering `distance`.
pub fn duration_for(distance: f64) -> Duration {
    Duration::from_secs_f64((FLOOR_MS + RATE * distance.powf(EXPONENT)).min(MAX_MS) / 1000.0)
}

/// The points to post, one per `TICK`, ending exactly on `to`.
///
/// At most `MAX_MS / TICK` samples however far apart the two points are, so a
/// sweep across three displays costs the same handful of events as a nudge.
pub fn glide(from: ScreenPoint, to: ScreenPoint) -> Vec<ScreenPoint> {
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let distance = dx.hypot(dy);
    if !distance.is_finite() || distance < DIRECT_DISTANCE {
        return vec![to];
    }

    // The curve bulges to one side of the straight line. Which side depends on
    // the direction of travel, which is free and reads as less mechanical than
    // always bowing the same way.
    let deflection = (distance * ARC).min(MAX_ARC) * if dx + dy >= 0.0 { 1.0 } else { -1.0 };
    let (perp_x, perp_y) = (-dy / distance, dx / distance);
    let control = |at: f64| {
        ScreenPoint::new(
            from.x + dx * at + perp_x * deflection,
            from.y + dy * at + perp_y * deflection,
        )
    };
    let (c1, c2) = (control(HANDLE), control(1.0 - HANDLE));

    let ticks = (duration_for(distance).as_secs_f64() / TICK.as_secs_f64()).round().max(1.0);
    let mut path: Vec<ScreenPoint> = (1..=ticks as u32)
        .map(|tick| bezier_at(from, c1, c2, to, eased(f64::from(tick) / ticks)))
        .collect();
    // Whatever the arithmetic did, the pointer lands where it was sent.
    *path.last_mut().expect("at least one tick") = to;
    path
}


#[cfg(test)]
mod tests {
    use super::*;

    fn total_time(samples: usize) -> Duration {
        TICK * samples as u32
    }

    #[test]
    fn a_short_hop_is_one_event() {
        let path = glide(ScreenPoint::new(100.0, 100.0), ScreenPoint::new(104.0, 103.0));
        assert_eq!(path, vec![ScreenPoint::new(104.0, 103.0)]);
    }

    #[test]
    fn every_glide_ends_exactly_on_the_target() {
        for target in [(300.0, 20.0), (-1200.0, 400.0), (5000.0, 3000.0), (0.0, 1.0)] {
            let to = ScreenPoint::new(target.0, target.1);
            let path = glide(ScreenPoint::new(10.0, 10.0), to);
            assert_eq!(*path.last().unwrap(), to, "for {target:?}");
        }
    }

    #[test]
    fn a_sweep_across_a_wide_desktop_still_finishes_inside_the_cap() {
        let path = glide(ScreenPoint::new(-3000.0, 0.0), ScreenPoint::new(6000.0, 2000.0));
        assert!(total_time(path.len()) <= Duration::from_secs_f64(MAX_MS / 1000.0) + TICK, "{} samples", path.len());
    }

    #[test]
    fn the_middle_of_a_glide_moves_faster_than_its_ends() {
        let path = glide(ScreenPoint::new(0.0, 0.0), ScreenPoint::new(1200.0, 0.0));
        let step = |i: usize| (path[i].x - path[i - 1].x).hypot(path[i].y - path[i - 1].y);
        let middle = step(path.len() / 2);
        assert!(middle > step(1), "middle {middle} vs first {}", step(1));
        assert!(middle > step(path.len() - 2), "middle {middle} vs last");
    }

    #[test]
    fn the_path_never_wanders_further_than_the_arc_cap() {
        let from = ScreenPoint::new(0.0, 0.0);
        let to = ScreenPoint::new(4000.0, 0.0);
        let worst = glide(from, to).iter().map(|p| p.y.abs()).fold(0.0, f64::max);
        assert!(worst <= MAX_ARC, "wandered {worst}");
    }

    #[test]
    fn a_reach_across_the_screen_takes_about_as_long_as_a_hand_would() {
        let millis = |distance: f64| duration_for(distance).as_millis();
        assert!((100..=200).contains(&millis(200.0)), "{}", millis(200.0));
        assert!((250..=450).contains(&millis(1200.0)), "{}", millis(1200.0));
        assert_eq!(millis(20_000.0), MAX_MS as u128);
    }

    #[test]
    fn a_target_that_is_not_a_number_does_not_hang() {
        let path = glide(ScreenPoint::new(0.0, 0.0), ScreenPoint::new(f64::NAN, 0.0));
        assert_eq!(path.len(), 1);
    }
}
