
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

    // this is so it stops after the duration
    oscillator.stop(audioContext.currentTime + duration);

    return audioContext;
}
