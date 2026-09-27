class PCM16Resampler extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const targetSampleRate = options.processorOptions.targetSampleRate;
        this.rateRatio = sampleRate / targetSampleRate;
        this.sourcePosition = 0;
        this.chunkSize = Math.round(targetSampleRate / 20);
        this.chunk = new Int16Array(this.chunkSize);
        this.chunkPosition = 0;
        this.voiceThreshold = 0.04;
    }

    process(inputs, outputs) {
        const input = inputs[0]?.[0];
        for (const output of outputs) {
            for (const channel of output) channel.fill(0);
        }
        if (!input) return true;

        let hasVoice = false;
        for (let i = 0; i < input.length; i++) {
            const sample = input[i];
            if (Math.abs(sample) > this.voiceThreshold) {
                hasVoice = true;
                break;
            }
        }

        if (!hasVoice) return true;

        while (this.sourcePosition < input.length) {
            const sample = input[Math.floor(this.sourcePosition)];
            const clipped = Math.max(-1, Math.min(1, sample));
            this.chunk[this.chunkPosition++] = Math.max(-32768, Math.min(32767, Math.round(clipped * 32767)));
            this.sourcePosition += this.rateRatio;

            if (this.chunkPosition === this.chunkSize) {
                const completedChunk = this.chunk;
                this.port.postMessage(completedChunk.buffer, [completedChunk.buffer]);
                this.chunk = new Int16Array(this.chunkSize);
                this.chunkPosition = 0;
            }
        }

        this.sourcePosition -= input.length;
        return true;
    }
}

registerProcessor('pcm16-resampler', PCM16Resampler);