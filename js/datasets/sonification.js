
export function playTone(frequency, duration = 1, amplitude = 0.3) {
    const audioContext = new AudioContext();
    

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gainNode.gain.value = amplitude;

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);

    return audioContext;
}

export function playSequence(
    tones,
    audioContext = new AudioContext()
) {

    tones.forEach(({ frequency, startTime, duration, amplitude }) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gainNode.gain.value = amplitude;

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        const scheduledStart = audioContext.currentTime + startTime;

        oscillator.start(scheduledStart);
        oscillator.stop(scheduledStart + duration);
    });

    return audioContext;
}

export async function renderSequence(tones) {
    const sampleRate = 44100;

    const totalDuration = Math.max(
        ...tones.map(tone => tone.startTime + tone.duration)
    );

    const offlineContext = new OfflineAudioContext(
        1,
        Math.ceil(totalDuration * sampleRate),
        sampleRate
    );

    tones.forEach(({ frequency, startTime, duration, amplitude }) => {
        const oscillator = offlineContext.createOscillator();
        const gainNode = offlineContext.createGain();

        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gainNode.gain.value = amplitude;

        oscillator.connect(gainNode);
        gainNode.connect(offlineContext.destination);

        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
    });

    return await offlineContext.startRendering();
}

