package com.spotpicker.app

/**
 * How believable the mock should look on the wire, per travel mode.
 *
 * Android apps — and especially anything that watches a position *continuously*,
 * such as WhatsApp's live location — are reading a stream of fixes, not a single
 * coordinate. A stream that repeats the exact same latitude and longitude
 * forever, at zero speed, is the one thing a real receiver never produces: real
 * GPS always wanders by a few metres even when you are standing still, and it
 * always reports how accurate it believes it is.
 *
 * So each mode carries the two numbers that make a fix look real:
 *
 *  - [accuracyMetres] is the horizontal accuracy reported with every fix. A
 *    receiver under open sky claims a few metres; indoors it claims tens.
 *  - [wanderMetres] is the radius of the random walk added around the selected
 *    point. It is deliberately larger when stationary than when moving, which is
 *    the opposite of what "jitter" usually means but exactly what a receiver
 *    does: satellite geometry is worst when you are not moving, and the error is
 *    smoothed away once you are.
 *
 * Speed is *not* here: the user picks that explicitly, and the mode only seeds
 * its default in the web app.
 */
enum class MotionMode(
    val id: String,
    val accuracyMetres: Float,
    val wanderMetres: Double,
) {
    /** A spot, not a journey. Still wanders, because a real pin does. */
    STATIONARY("stationary", 6f, 3.5),
    WALK("walk", 8f, 2.5),
    RUN("run", 7f, 2.0),
    CYCLE("cycle", 6f, 1.5),
    DRIVE("drive", 9f, 1.0),

    /** A mode the web app did not describe; behave like walking. */
    CUSTOM("custom", 7f, 1.5),
    ;

    companion object {
        /**
         * The mode for an id sent across the bridge. Anything unrecognised falls
         * back to a plausible default rather than failing the start: a bad mode
         * id is a version skew, not something worth refusing to run over.
         */
        fun from(id: String?): MotionMode {
            val wanted = id?.trim()?.lowercase() ?: return STATIONARY
            return entries.firstOrNull { it.id == wanted } ?: CUSTOM
        }
    }
}
