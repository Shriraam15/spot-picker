package com.spotpicker.app

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** One vertex of a simulated route. */
data class RoutePoint(val lat: Double, val lon: Double)

/** A position along the route, plus the heading to report with it. */
data class RouteSample(val point: RoutePoint, val bearingDegrees: Double)

/**
 * Geometry for route playback, kept free of Android types so the maths can be
 * reasoned about (and compiled) on its own.
 *
 * Distances use the haversine formula on a spherical earth. That is accurate to
 * a few metres over the distances a simulated route covers, and the "wrong"
 * model is precisely what a phone's own GPS distance readout would disagree
 * with least.
 */
object MockRoute {

    private const val EARTH_RADIUS_M = 6_371_008.8

    /** Great-circle distance in metres. */
    fun distanceMetres(a: RoutePoint, b: RoutePoint): Double {
        val dLat = Math.toRadians(b.lat - a.lat)
        val dLon = Math.toRadians(b.lon - a.lon)
        val lat1 = Math.toRadians(a.lat)
        val lat2 = Math.toRadians(b.lat)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            cos(lat1) * cos(lat2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /** Length of the whole polyline. */
    fun totalDistance(points: List<RoutePoint>): Double {
        var sum = 0.0
        for (i in 1 until points.size) sum += distanceMetres(points[i - 1], points[i])
        return sum
    }

    /** Initial bearing from [a] to [b], in degrees clockwise from north. */
    fun bearingDegrees(a: RoutePoint, b: RoutePoint): Double {
        val lat1 = Math.toRadians(a.lat)
        val lat2 = Math.toRadians(b.lat)
        val dLon = Math.toRadians(b.lon - a.lon)
        val y = sin(dLon) * cos(lat2)
        val x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /**
     * The point [travelled] metres along the polyline, clamped to the ends.
     * Interpolation is linear in lat/lon: over a single segment the error is
     * below the accuracy the mock provider reports anyway.
     */
    fun sampleAt(points: List<RoutePoint>, travelled: Double): RouteSample {
        if (points.isEmpty()) throw IllegalArgumentException("route has no points")
        if (points.size == 1) return RouteSample(points[0], 0.0)

        var remaining = travelled.coerceAtLeast(0.0)
        for (i in 1 until points.size) {
            val from = points[i - 1]
            val to = points[i]
            val segment = distanceMetres(from, to)
            if (segment <= 0.0) continue
            if (remaining <= segment) {
                val t = remaining / segment
                return RouteSample(
                    RoutePoint(
                        lat = from.lat + (to.lat - from.lat) * t,
                        lon = from.lon + (to.lon - from.lon) * t,
                    ),
                    bearingDegrees(from, to),
                )
            }
            remaining -= segment
        }

        // Past the end: sit on the last vertex, facing the way we arrived.
        val last = points.last()
        val before = points[points.size - 2]
        return RouteSample(last, bearingDegrees(before, last))
    }

    /**
     * Parses the `[[lat,lon], …]` payload the web app sends. Returns an empty
     * list for anything malformed rather than throwing across the bridge, and
     * drops points that are not on earth.
     */
    fun parse(payload: String): List<RoutePoint> {
        val out = mutableListOf<RoutePoint>()
        try {
            val array = org.json.JSONArray(payload)
            for (i in 0 until array.length()) {
                val pair = array.optJSONArray(i) ?: continue
                val lat = pair.optDouble(0, Double.NaN)
                val lon = pair.optDouble(1, Double.NaN)
                if (lat.isNaN() || lon.isNaN()) continue
                if (abs(lat) > 90.0 || abs(lon) > 180.0) continue
                out += RoutePoint(lat, lon)
            }
        } catch (e: Exception) {
            return emptyList()
        }
        return out
    }
}
