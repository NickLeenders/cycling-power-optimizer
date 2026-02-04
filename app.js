/**
 * Cycling Power Optimizer
 * 
 * Client-side application that calculates optimal power output for a cycling route
 * based on terrain, wind conditions, and rider FTP.
 */

// ============================================
// Constants & Configuration
// ============================================

const CONSTANTS = {
    GRAVITY: 9.81,              // m/s²
    AIR_DENSITY: 1.225,         // kg/m³ at sea level
    EARTH_RADIUS: 6371000,      // meters
    DRIVETRAIN_LOSS: 0.03,      // 3% drivetrain efficiency loss
    MIN_POWER: 50,              // Minimum power (coasting/recovery)
    MAX_POWER_FACTOR: 1.20,     // Maximum 120% of FTP for sustained efforts
    SEGMENT_LENGTH: 100,        // Target segment length in meters for smoothing
};

// Power zone colors for map visualization
const POWER_ZONES = {
    recovery: { max: 0.75, color: '#3b82f6' },
    endurance: { max: 0.90, color: '#22c55e' },
    tempo: { max: 1.05, color: '#eab308' },
    threshold: { max: 1.20, color: '#f97316' },
    vo2max: { max: Infinity, color: '#ef4444' }
};

// ============================================
// State Management
// ============================================

const state = {
    route: null,
    segments: [],
    optimizedPower: [],
    map: null,
    chart: null,
    routeLayer: null
};

// ============================================
// DOM Elements
// ============================================

const elements = {
    gpxInput: document.getElementById('gpxInput'),
    fileUpload: document.getElementById('fileUpload'),
    calculateBtn: document.getElementById('calculateBtn'),
    loadingOverlay: document.getElementById('loadingOverlay'),

    // Route info
    totalDistance: document.getElementById('totalDistance'),
    elevationGain: document.getElementById('elevationGain'),
    maxGradient: document.getElementById('maxGradient'),

    // Inputs
    ftp: document.getElementById('ftp'),
    riderWeight: document.getElementById('riderWeight'),
    bikeWeight: document.getElementById('bikeWeight'),
    windSpeed: document.getElementById('windSpeed'),
    windDirection: document.getElementById('windDirection'),
    cda: document.getElementById('cda'),
    crr: document.getElementById('crr'),
    wprime: document.getElementById('wprime'),

    // Ride mode
    rideModeOptions: document.getElementById('rideModeOptions'),

    // Target intensity
    targetIntensity: document.getElementById('targetIntensity'),
    intensityValue: document.getElementById('intensityValue'),
    autoRecommendBtn: document.getElementById('autoRecommendBtn'),
    recommendedInfo: document.getElementById('recommendedInfo'),
    recommendedValue: document.getElementById('recommendedValue'),

    // Wind display
    compassArrow: document.getElementById('compassArrow'),
    windDegrees: document.getElementById('windDegrees'),

    // Results
    resultsCard: document.getElementById('resultsCard'),
    estTime: document.getElementById('estTime'),
    avgPower: document.getElementById('avgPower'),
    normPower: document.getElementById('normPower'),
    intensityFactor: document.getElementById('intensityFactor'),
    tss: document.getElementById('tss'),
    avgSpeed: document.getElementById('avgSpeed'),
    wprimeGauge: document.getElementById('wprimeGauge'),
    wprimePercent: document.getElementById('wprimePercent'),

    // Info modal
    infoBtn: document.getElementById('infoBtn'),
    infoModal: document.getElementById('infoModal'),
    modalClose: document.getElementById('modalClose')
};

// Ride mode intensity modifiers (applied to base intensity recommendation)
const RIDE_MODES = {
    race: { modifier: 0, name: 'Race', description: 'Maximum sustainable effort' },
    touring: { modifier: -12, name: 'Touring', description: 'Save legs for tomorrow' },
    tri703: { modifier: -6, name: '70.3', description: 'Save for 21km run' },
    triFull: { modifier: -10, name: 'Ironman', description: 'Save for 42km run' }
};

let currentRideMode = 'race';

// Modal functions
function openInfoModal() {
    elements.infoModal.classList.add('visible');
}

function closeInfoModal() {
    elements.infoModal.classList.remove('visible');
}

// ============================================
// GPX Parser Module
// ============================================

const GPXParser = {
    /**
     * Parse GPX file content and extract track points
     */
    parse(gpxContent) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxContent, 'text/xml');

        const trackPoints = xmlDoc.querySelectorAll('trkpt');
        const points = [];

        trackPoints.forEach(pt => {
            points.push({
                lat: parseFloat(pt.getAttribute('lat')),
                lon: parseFloat(pt.getAttribute('lon')),
                ele: parseFloat(pt.querySelector('ele')?.textContent) || 0
            });
        });

        return points;
    },

    /**
     * Calculate distance between two points using Haversine formula
     */
    haversineDistance(lat1, lon1, lat2, lon2) {
        const toRad = deg => deg * Math.PI / 180;

        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);

        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return CONSTANTS.EARTH_RADIUS * c;
    },

    /**
     * Calculate bearing between two points
     */
    calculateBearing(lat1, lon1, lat2, lon2) {
        const toRad = deg => deg * Math.PI / 180;
        const toDeg = rad => rad * 180 / Math.PI;

        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

        let bearing = toDeg(Math.atan2(y, x));
        return (bearing + 360) % 360;
    },

    /**
     * Process raw points into route segments
     */
    processRoute(points) {
        const segments = [];
        let cumulativeDistance = 0;

        for (let i = 1; i < points.length; i++) {
            const p1 = points[i - 1];
            const p2 = points[i];

            const distance = this.haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);

            // Skip very short segments
            if (distance < 1) continue;

            const elevationChange = p2.ele - p1.ele;
            const gradient = distance > 0 ? (elevationChange / distance) : 0;
            const bearing = this.calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);

            cumulativeDistance += distance;

            segments.push({
                startLat: p1.lat,
                startLon: p1.lon,
                endLat: p2.lat,
                endLon: p2.lon,
                distance: distance,
                cumulativeDistance: cumulativeDistance,
                elevation: p2.ele,
                gradient: gradient,
                bearing: bearing
            });
        }

        return segments;
    },

    /**
     * Smooth segments by combining short ones
     */
    smoothSegments(segments, targetLength = CONSTANTS.SEGMENT_LENGTH) {
        const smoothed = [];
        let accumulated = {
            distance: 0,
            elevationStart: segments[0]?.elevation || 0,
            elevationSum: 0,
            bearingX: 0,
            bearingY: 0,
            startLat: segments[0]?.startLat,
            startLon: segments[0]?.startLon,
            endLat: 0,
            endLon: 0,
            cumulativeDistance: 0
        };

        segments.forEach((seg, i) => {
            accumulated.distance += seg.distance;
            accumulated.elevationSum += seg.elevation * seg.distance;
            accumulated.bearingX += Math.cos(seg.bearing * Math.PI / 180) * seg.distance;
            accumulated.bearingY += Math.sin(seg.bearing * Math.PI / 180) * seg.distance;
            accumulated.endLat = seg.endLat;
            accumulated.endLon = seg.endLon;
            accumulated.cumulativeDistance = seg.cumulativeDistance;

            if (accumulated.distance >= targetLength || i === segments.length - 1) {
                const avgElevation = accumulated.elevationSum / accumulated.distance;
                const bearing = (Math.atan2(accumulated.bearingY, accumulated.bearingX) * 180 / Math.PI + 360) % 360;
                const gradient = (avgElevation - accumulated.elevationStart) / accumulated.distance;

                smoothed.push({
                    startLat: accumulated.startLat,
                    startLon: accumulated.startLon,
                    endLat: accumulated.endLat,
                    endLon: accumulated.endLon,
                    distance: accumulated.distance,
                    cumulativeDistance: accumulated.cumulativeDistance,
                    elevation: avgElevation,
                    gradient: gradient,
                    bearing: bearing
                });

                // Reset accumulator
                accumulated = {
                    distance: 0,
                    elevationStart: avgElevation,
                    elevationSum: 0,
                    bearingX: 0,
                    bearingY: 0,
                    startLat: accumulated.endLat,
                    startLon: accumulated.endLon,
                    endLat: 0,
                    endLon: 0,
                    cumulativeDistance: accumulated.cumulativeDistance
                };
            }
        });

        return smoothed;
    }
};

// ============================================
// Physics Engine Module
// ============================================

const PhysicsEngine = {
    /**
     * Calculate power required to maintain a given speed on a segment
     */
    powerRequired(speed, gradient, headwind, params) {
        const { totalMass, cda, crr } = params;

        // Effective air speed (rider speed + headwind component)
        const airSpeed = speed + headwind;

        // Aerodynamic drag power: P = 0.5 * ρ * CdA * v_air² * v_ground
        // Using v_air for drag force, v_ground for power
        const P_aero = 0.5 * CONSTANTS.AIR_DENSITY * cda * (airSpeed ** 2) * speed;

        // Gravity power: P = m * g * gradient * v
        const P_gravity = totalMass * CONSTANTS.GRAVITY * gradient * speed;

        // Rolling resistance power: P = Crr * m * g * v * cos(atan(gradient))
        const cosGradient = Math.cos(Math.atan(gradient));
        const P_rolling = crr * totalMass * CONSTANTS.GRAVITY * cosGradient * speed;

        // Total power including drivetrain losses
        const P_total = (P_aero + P_gravity + P_rolling) / (1 - CONSTANTS.DRIVETRAIN_LOSS);

        return Math.max(CONSTANTS.MIN_POWER, P_total);
    },

    /**
     * Calculate speed achievable at a given power output
     * Uses Newton-Raphson iteration for solving
     */
    speedAtPower(power, gradient, headwind, params) {
        const { totalMass, cda, crr } = params;

        // Initial guess based on flat road speed
        let speed = Math.pow(power / (0.5 * CONSTANTS.AIR_DENSITY * cda), 1 / 3);

        // Newton-Raphson iteration
        for (let i = 0; i < 20; i++) {
            const currentPower = this.powerRequired(speed, gradient, headwind, params);
            const error = currentPower - power;

            if (Math.abs(error) < 0.1) break;

            // Numerical derivative
            const dSpeed = 0.1;
            const dPower = this.powerRequired(speed + dSpeed, gradient, headwind, params) - currentPower;
            const derivative = dPower / dSpeed;

            if (Math.abs(derivative) < 0.001) break;

            speed = speed - error / derivative;
            speed = Math.max(1, Math.min(speed, 30)); // Clamp between 1-30 m/s
        }

        return speed;
    },

    /**
     * Calculate headwind component based on wind direction and travel bearing
     */
    calculateHeadwind(windSpeed, windDirection, bearing) {
        // Wind direction is "from" direction, convert to "to" direction
        const windTo = (windDirection + 180) % 360;

        // Angle between wind direction and travel direction
        const angleRad = (windTo - bearing) * Math.PI / 180;

        // Headwind is negative component (wind against us)
        return -windSpeed * Math.cos(angleRad);
    }
};

// ============================================
// Power Optimization Module
// ============================================

const PowerOptimizer = {
    /**
     * Optimize power distribution across segments using W' balance model
     * Strategy: Target near-FTP power, push harder on climbs, recover on descents
     */
    optimize(segments, params) {
        const { ftp, wprime, windSpeed, windDirection, totalMass, cda, crr, targetIntensity } = params;

        // Target power based on intensity (for duration sustainability)
        const basePower = ftp * (targetIntensity / 100);
        // maxPower must allow going above FTP on steep climbs (that's the point of W')
        const maxPower = ftp * CONSTANTS.MAX_POWER_FACTOR; // Up to 125-130% FTP
        const minPower = basePower * 0.5; // Don't go below 50% of target
        const results = [];

        // First pass: calculate optimal power for each segment
        segments.forEach(seg => {
            const headwind = PhysicsEngine.calculateHeadwind(
                windSpeed / 3.6, // Convert km/h to m/s
                windDirection,
                seg.bearing
            );

            // Base strategy: target intensity of FTP as baseline, adjust for gradient and wind
            let targetPower = basePower;

            // Gradient adjustment: push harder uphill (more time benefit per watt)
            // Aggressiveness scales with target intensity: 
            // At 100% FTP target = full boost, at 65% FTP target = minimal boost
            const aggressiveness = Math.max(0, (targetIntensity - 65) / 35); // 0 to 1
            const gradientPercent = seg.gradient * 100;

            if (gradientPercent > 2.0) {
                // Uphill (>2%): push toward or above FTP based on aggressiveness
                // At high intensity: push above FTP (uses W')
                // At low intensity: cap at FTP (conservative)
                const maxBoost = 0.10 + aggressiveness * 0.20; // 10-30% above FTP
                const powerBoost = Math.min((gradientPercent - 2) * 0.10, maxBoost) * aggressiveness;
                const climbTarget = ftp * (1 + powerBoost);
                targetPower = Math.max(basePower, climbTarget); // Never go below basePower on climb
            } else if (gradientPercent > 0.5) {
                // Moderate uphill (0.5-2%): ramp up from basePower toward FTP
                const rampFactor = (gradientPercent - 0.5) / 1.5; // 0 to 1
                targetPower = basePower + rampFactor * (ftp - basePower) * aggressiveness;
            } else if (gradientPercent < -2.0) {
                // Steep downhill: significant power reduction for recovery
                const powerReduction = Math.min(Math.abs(gradientPercent) * 0.12, 0.40);
                targetPower = basePower * (1 - powerReduction);
            } else if (gradientPercent < 0) {
                // Gentle downhill: moderate power reduction
                const powerReduction = Math.abs(gradientPercent) * 0.05;
                targetPower = basePower * (1 - powerReduction);
            }
            // Flat sections (0% to 0.5%): keep basePower

            // Wind adjustment: slight increase into headwind, slight decrease with tailwind
            if (headwind < 0) {
                // Headwind (negative = wind against us): slight power boost
                const windBoost = Math.min(Math.abs(headwind) * 0.02, 0.10);
                targetPower *= (1 + windBoost);
            } else if (headwind > 0) {
                // Tailwind: slight power reduction
                const windReduction = Math.min(headwind * 0.015, 0.08);
                targetPower *= (1 - windReduction);
            }

            // Clamp to valid range
            targetPower = Math.max(minPower, Math.min(maxPower, targetPower));

            results.push({
                ...seg,
                headwind: headwind,
                optimizedPower: targetPower
            });
        });

        // Second pass: apply W' balance constraints
        let wBalance = wprime;
        let minWBalance = wprime;

        results.forEach((seg, i) => {
            const speed = PhysicsEngine.speedAtPower(
                seg.optimizedPower,
                seg.gradient,
                seg.headwind,
                { totalMass, cda, crr }
            );
            const segmentTime = seg.distance / speed;

            if (seg.optimizedPower > ftp) {
                // Above FTP: W' depletes
                const wCost = (seg.optimizedPower - ftp) * segmentTime;

                // Check if we can afford this
                if (wBalance - wCost < wprime * 0.15) {
                    // Not enough W' reserve, reduce power to basePower
                    seg.optimizedPower = basePower;
                } else {
                    wBalance -= wCost;
                }
            } else {
                // Below FTP: W' recovers
                // Recovery is slower than depletion (about 30% of depletion rate)
                const wRecovery = (ftp - seg.optimizedPower) * segmentTime * 0.30;
                wBalance = Math.min(wprime, wBalance + wRecovery);
            }

            seg.wBalance = wBalance;
            minWBalance = Math.min(minWBalance, wBalance);
        });

        // Third pass: calculate final metrics with optimized power
        let totalTime = 0;
        let powerSum = 0;
        let power4Sum = 0;

        results.forEach(seg => {
            const speed = PhysicsEngine.speedAtPower(
                seg.optimizedPower,
                seg.gradient,
                seg.headwind,
                { totalMass, cda, crr }
            );
            seg.speed = speed;
            seg.time = seg.distance / speed;

            totalTime += seg.time;
            powerSum += seg.optimizedPower * seg.time;
            power4Sum += Math.pow(seg.optimizedPower, 4) * seg.time;
        });

        const avgPower = powerSum / totalTime;
        const normPower = Math.pow(power4Sum / totalTime, 0.25);
        const intensityFactor = normPower / ftp;
        const tss = (totalTime / 3600) * intensityFactor * intensityFactor * 100;
        const totalDistance = segments[segments.length - 1]?.cumulativeDistance || 0;
        const avgSpeed = (totalDistance / 1000) / (totalTime / 3600);

        return {
            segments: results,
            metrics: {
                totalTime,
                avgPower,
                normPower,
                intensityFactor,
                tss,
                avgSpeed,
                minWBalance,
                wprimePercent: (minWBalance / wprime) * 100
            }
        };
    }
};

// ============================================
// Visualization Module
// ============================================

const Visualization = {
    /**
     * Initialize Leaflet map
     */
    initMap() {
        if (state.map) {
            state.map.remove();
        }

        state.map = L.map('map', {
            zoomControl: true,
            attributionControl: false
        }).setView([45.2, 13.6], 12);

        // Dark tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(state.map);
    },

    /**
     * Draw route on map with power-colored segments
     */
    drawRoute(segments, ftp) {
        if (state.routeLayer) {
            state.map.removeLayer(state.routeLayer);
        }

        state.routeLayer = L.layerGroup();

        segments.forEach(seg => {
            const powerRatio = seg.optimizedPower / ftp;
            let color;

            if (powerRatio < POWER_ZONES.recovery.max) {
                color = POWER_ZONES.recovery.color;
            } else if (powerRatio < POWER_ZONES.endurance.max) {
                color = POWER_ZONES.endurance.color;
            } else if (powerRatio < POWER_ZONES.tempo.max) {
                color = POWER_ZONES.tempo.color;
            } else if (powerRatio < POWER_ZONES.threshold.max) {
                color = POWER_ZONES.threshold.color;
            } else {
                color = POWER_ZONES.vo2max.color;
            }

            const polyline = L.polyline(
                [[seg.startLat, seg.startLon], [seg.endLat, seg.endLon]],
                { color: color, weight: 4, opacity: 0.9 }
            );

            polyline.bindPopup(`
                <strong>Power:</strong> ${Math.round(seg.optimizedPower)}W<br>
                <strong>Gradient:</strong> ${(seg.gradient * 100).toFixed(1)}%<br>
                <strong>Speed:</strong> ${(seg.speed * 3.6).toFixed(1)} km/h
            `);

            state.routeLayer.addLayer(polyline);
        });

        state.routeLayer.addTo(state.map);

        // Fit map to route bounds
        const allPoints = segments.flatMap(s => [[s.startLat, s.startLon], [s.endLat, s.endLon]]);
        if (allPoints.length > 0) {
            state.map.fitBounds(allPoints, { padding: [20, 20] });
        }
    },

    /**
     * Initialize or update the elevation/power chart
     */
    updateChart(segments) {
        const ctx = document.getElementById('profileChart').getContext('2d');

        // Prepare data
        const labels = segments.map(s => (s.cumulativeDistance / 1000).toFixed(1));
        const elevationData = segments.map(s => s.elevation);
        const powerData = segments.map(s => s.optimizedPower);

        // Calculate power axis range (with some padding)
        const minPower = Math.min(...powerData);
        const maxPower = Math.max(...powerData);
        const powerPadding = (maxPower - minPower) * 0.15;
        const powerAxisMin = Math.max(0, Math.floor((minPower - powerPadding) / 25) * 25);
        const powerAxisMax = Math.ceil((maxPower + powerPadding) / 25) * 25;

        if (state.chart) {
            state.chart.data.labels = labels;
            state.chart.data.datasets[0].data = elevationData;
            state.chart.data.datasets[1].data = powerData;
            state.chart.options.scales.y1.min = powerAxisMin;
            state.chart.options.scales.y1.max = powerAxisMax;
            state.chart.update();
            return;
        }

        state.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Elevation (m)',
                        data: elevationData,
                        borderColor: '#00d4ff',
                        backgroundColor: 'rgba(0, 212, 255, 0.1)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Power (W)',
                        data: powerData,
                        borderColor: '#f97316',
                        backgroundColor: 'rgba(249, 115, 22, 0.1)',
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#a0a0b0',
                            font: { size: 11 }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(25, 25, 35, 0.95)',
                        titleColor: '#fff',
                        bodyColor: '#a0a0b0',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    x: {
                        display: true,
                        title: {
                            display: true,
                            text: 'Distance (km)',
                            color: '#606070'
                        },
                        ticks: { color: '#606070', maxTicksLimit: 10 },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'Elevation (m)',
                            color: '#00d4ff'
                        },
                        ticks: { color: '#00d4ff' },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        min: powerAxisMin,
                        max: powerAxisMax,
                        title: {
                            display: true,
                            text: 'Power (W)',
                            color: '#f97316'
                        },
                        ticks: { color: '#f97316' },
                        grid: { drawOnChartArea: false }
                    }
                }
            }
        });
    },

    /**
     * Update results display
     */
    updateResults(metrics) {
        const formatTime = seconds => {
            const hours = Math.floor(seconds / 3600);
            const mins = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            return hours > 0
                ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
                : `${mins}:${secs.toString().padStart(2, '0')}`;
        };

        elements.estTime.textContent = formatTime(metrics.totalTime);
        elements.avgPower.textContent = Math.round(metrics.avgPower);
        elements.normPower.textContent = Math.round(metrics.normPower);
        elements.intensityFactor.textContent = metrics.intensityFactor.toFixed(2);
        elements.tss.textContent = Math.round(metrics.tss);
        elements.avgSpeed.textContent = metrics.avgSpeed.toFixed(1);

        // W' gauge
        const wPercent = Math.max(0, Math.min(100, metrics.wprimePercent));
        elements.wprimeGauge.style.width = `${wPercent}%`;
        elements.wprimePercent.textContent = `${Math.round(wPercent)}%`;

        elements.resultsCard.classList.add('active');
    }
};

// ============================================
// UI Event Handlers
// ============================================

function updateRouteInfo(segments) {
    const totalDist = segments[segments.length - 1]?.cumulativeDistance || 0;
    elements.totalDistance.textContent = `${(totalDist / 1000).toFixed(1)} km`;

    // Calculate elevation gain
    let elevGain = 0;
    for (let i = 1; i < segments.length; i++) {
        const diff = segments[i].elevation - segments[i - 1].elevation;
        if (diff > 0) elevGain += diff;
    }
    elements.elevationGain.textContent = `${Math.round(elevGain)} m`;

    // Max gradient
    const maxGrad = Math.max(...segments.map(s => Math.abs(s.gradient)));
    elements.maxGradient.textContent = `${(maxGrad * 100).toFixed(1)}%`;
}

function updateWindCompass() {
    const degrees = parseInt(elements.windDirection.value);
    elements.compassArrow.style.transform = `rotate(${degrees}deg)`;
    elements.windDegrees.textContent = `${degrees}°`;
}

function getParams() {
    return {
        ftp: parseFloat(elements.ftp.value),
        riderWeight: parseFloat(elements.riderWeight.value),
        bikeWeight: parseFloat(elements.bikeWeight.value),
        totalMass: parseFloat(elements.riderWeight.value) + parseFloat(elements.bikeWeight.value),
        windSpeed: parseFloat(elements.windSpeed.value),
        windDirection: parseFloat(elements.windDirection.value),
        cda: parseFloat(elements.cda.value),
        crr: parseFloat(elements.crr.value),
        wprime: parseFloat(elements.wprime.value),
        targetIntensity: parseFloat(elements.targetIntensity.value)
    };
}

function updateIntensitySlider() {
    const intensity = parseInt(elements.targetIntensity.value);
    elements.intensityValue.textContent = `${intensity}%`;
}

/**
 * Calculate recommended intensity based on estimated ride duration and ride mode
 * Uses power-duration relationship for cycling
 */
function autoRecommendIntensity() {
    if (!state.segments || state.segments.length === 0) {
        alert('Please load a GPX file first.');
        return;
    }

    const params = getParams();
    // First, estimate duration at 100% FTP to get a baseline
    const testParams = { ...params, targetIntensity: 100 };
    const testResult = PowerOptimizer.optimize(state.segments, testParams);
    const estimatedHours = testResult.metrics.totalTime / 3600;

    // Power-duration curve: intensity decreases with duration
    // Based on typical endurance athlete data:
    // 1 hour = 95-100%, 2 hours = 85-90%, 3 hours = 78-82%, 4 hours = 72-76%, 5+ hours = 65-70%
    let baseIntensity;
    if (estimatedHours <= 1) {
        baseIntensity = 95;
    } else if (estimatedHours <= 2) {
        baseIntensity = 95 - (estimatedHours - 1) * 10; // 95 -> 85
    } else if (estimatedHours <= 3) {
        baseIntensity = 85 - (estimatedHours - 2) * 7; // 85 -> 78
    } else if (estimatedHours <= 4) {
        baseIntensity = 78 - (estimatedHours - 3) * 6; // 78 -> 72
    } else {
        baseIntensity = Math.max(65, 72 - (estimatedHours - 4) * 3); // Gradually decrease to 65%
    }

    // Apply ride mode modifier
    const modeModifier = RIDE_MODES[currentRideMode].modifier;
    let recommendedIntensity = Math.round(baseIntensity + modeModifier);

    // Clamp to valid range
    recommendedIntensity = Math.max(60, Math.min(100, recommendedIntensity));

    // Update slider
    elements.targetIntensity.value = recommendedIntensity;
    updateIntensitySlider();

    // Show recommendation info
    const modeName = RIDE_MODES[currentRideMode].name;
    const modeText = modeModifier !== 0 ? ` (${modeName}: ${modeModifier > 0 ? '+' : ''}${modeModifier}%)` : '';
    elements.recommendedInfo.style.display = 'flex';
    elements.recommendedValue.textContent = `${recommendedIntensity}%${modeText}`;
}

function selectRideMode(mode) {
    currentRideMode = mode;

    // Update button states
    document.querySelectorAll('.ride-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Auto-update recommendation if route is loaded
    if (state.segments && state.segments.length > 0) {
        autoRecommendIntensity();
    }
}

async function handleFileUpload(file) {
    const content = await file.text();
    const points = GPXParser.parse(content);

    if (points.length < 2) {
        alert('Invalid GPX file or no track points found.');
        return;
    }

    const rawSegments = GPXParser.processRoute(points);
    state.segments = GPXParser.smoothSegments(rawSegments);
    state.route = points;

    updateRouteInfo(state.segments);

    // Show basic route on map
    Visualization.initMap();

    // Draw route without power optimization for preview
    const previewSegments = state.segments.map(s => ({
        ...s,
        optimizedPower: getParams().ftp,
        speed: 10
    }));
    Visualization.drawRoute(previewSegments, getParams().ftp);
}

function calculate() {
    if (!state.segments || state.segments.length === 0) {
        alert('Please load a GPX file first.');
        return;
    }

    elements.loadingOverlay.classList.add('visible');

    // Use setTimeout to allow UI to update
    setTimeout(() => {
        const params = getParams();
        const result = PowerOptimizer.optimize(state.segments, params);

        state.optimizedPower = result.segments;

        Visualization.drawRoute(result.segments, params.ftp);
        Visualization.updateChart(result.segments);
        Visualization.updateResults(result.metrics);

        elements.loadingOverlay.classList.remove('visible');
    }, 100);
}

// ============================================
// Event Listeners
// ============================================

// File upload
elements.gpxInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleFileUpload(file);
});

// Drag and drop
elements.fileUpload.addEventListener('dragover', e => {
    e.preventDefault();
    elements.fileUpload.classList.add('dragover');
});

elements.fileUpload.addEventListener('dragleave', () => {
    elements.fileUpload.classList.remove('dragover');
});

elements.fileUpload.addEventListener('drop', e => {
    e.preventDefault();
    elements.fileUpload.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.gpx')) {
        handleFileUpload(file);
    }
});

// Wind direction slider
elements.windDirection.addEventListener('input', updateWindCompass);

// Info modal
elements.infoBtn.addEventListener('click', openInfoModal);
elements.modalClose.addEventListener('click', closeInfoModal);
elements.infoModal.addEventListener('click', e => {
    if (e.target === elements.infoModal) closeInfoModal();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeInfoModal();
});

// Ride mode buttons
elements.rideModeOptions.addEventListener('click', e => {
    const btn = e.target.closest('.ride-mode-btn');
    if (btn) {
        selectRideMode(btn.dataset.mode);
    }
});

// Target intensity slider
elements.targetIntensity.addEventListener('input', updateIntensitySlider);

// Auto-recommend button
elements.autoRecommendBtn.addEventListener('click', autoRecommendIntensity);

// Calculate button
elements.calculateBtn.addEventListener('click', calculate);

// ============================================
// Initialization
// ============================================

async function init() {
    Visualization.initMap();
    updateWindCompass();
    updateIntensitySlider();

    // Load default GPX file if available
    try {
        const response = await fetch('IM 70.3 Porec Croatia Bike 2025.gpx');
        if (response.ok) {
            const content = await response.text();
            const points = GPXParser.parse(content);
            const rawSegments = GPXParser.processRoute(points);
            state.segments = GPXParser.smoothSegments(rawSegments);
            state.route = points;

            updateRouteInfo(state.segments);

            // Draw preview
            const previewSegments = state.segments.map(s => ({
                ...s,
                optimizedPower: getParams().ftp,
                speed: 10
            }));
            Visualization.drawRoute(previewSegments, getParams().ftp);
        }
    } catch (e) {
        console.log('Default GPX not loaded:', e.message);
    }
}

// Start app
init();
