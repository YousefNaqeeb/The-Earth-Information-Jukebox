export function calculateTempo(playbackDuration, beatCount = 64) {
    if (!Number.isFinite(playbackDuration) || playbackDuration <= 0) {
        return 120;
    }

    return Math.round((beatCount / playbackDuration) * 60);
}

export function createDrumPattern(playbackDuration, beatCount = 64) {
    const bpm = calculateTempo(playbackDuration, beatCount);
    const beatDuration = 60 / bpm;
    const drums = [];

    for (let beat = 0; beat < beatCount; beat++) {
        const startTime = beat * beatDuration;

        if (beat % 4 === 0) {
            drums.push({
                type: "kick",
                startTime,
                amplitude: 0.7
            });
        }

        if (beat % 4 === 2) {
            drums.push({
                type: "snare",
                startTime,
                amplitude: 0.35
            });
        }
    }

    return {
        bpm,
        beatDuration,
        duration: playbackDuration,
        drums
    };
}

// Generate drum sounds using the Web Audio API.
export function playDrumbeat(pattern, audioContext = new AudioContext()) {
    const masterGain = audioContext.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(audioContext.destination);

    pattern.drums.forEach(drum => {
        const start = audioContext.currentTime + drum.startTime;

        if (drum.type === "kick") {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(150, start);
            oscillator.frequency.exponentialRampToValueAtTime(45, start + 0.12);

            gain.gain.setValueAtTime(drum.amplitude, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);

            oscillator.connect(gain);
            gain.connect(masterGain);

            oscillator.start(start);
            oscillator.stop(start + 0.16);
        }

        if (drum.type === "snare") {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();

            oscillator.type = "triangle";
            oscillator.frequency.value = 180;

            gain.gain.setValueAtTime(drum.amplitude, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.1);

            oscillator.connect(gain);
            gain.connect(masterGain);

            oscillator.start(start);
            oscillator.stop(start + 0.11);
        }
    });

    return audioContext;
}

