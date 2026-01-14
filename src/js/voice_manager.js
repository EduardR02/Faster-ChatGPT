export class VoiceManager {
    constructor(apiManager, stateManager, { getActiveTabId, onTranscript, onError }) {
        Object.assign(this, { 
            api: apiManager, 
            state: stateManager, 
            getActiveTabId, 
            onTranscript, 
            onError, 
            chunks: [], 
            busy: false, 
            recorder: null, 
            stream: null, 
            recordingTabId: null, 
            mimeType: null 
        });
        this.init();
    }

    init() {
        const toggleButton = document.getElementById('voice-transcribe-toggle');
        if (!toggleButton) return;

        this.updateBtn = () => {
            toggleButton.classList.toggle('recording', this.recorder?.state === 'recording');
            toggleButton.classList.toggle('busy', this.busy);
        };

        toggleButton.onclick = () => {
            if (this.busy) return;
            if (this.recorder?.state === 'recording') {
                this.stopAndTranscribe();
            } else {
                this.start();
            }
        };

        this.updateBtn();
    }

    async start() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const supportedType = [
                'audio/webm;codecs=opus', 
                'audio/webm', 
                'audio/ogg;codecs=opus', 
                'audio/ogg'
            ].find(type => MediaRecorder?.isTypeSupported?.(type));
            
            this.recorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : {});
            this.recorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    this.chunks.push(event.data);
                }
            };

            Object.assign(this, { 
                mimeType: this.recorder.mimeType || supportedType || 'audio/webm', 
                recordingTabId: this.getActiveTabId(), 
                chunks: [], 
                stream 
            });

            this.recorder.start();
        } catch (error) {
            const errorMessage = error.name === 'NotAllowedError' 
                ? 'Microphone permission denied. Enable it in settings.' 
                : this.api.getUiErrorMessage(error, { prefix: 'Microphone error' });
            
            this.onError(errorMessage);
            this.cleanup();
        } finally {
            this.updateBtn();
        }
    }

    cleanup() {
        const activeStream = this.stream;
        Object.assign(this, { 
            recorder: null, 
            recordingTabId: null, 
            chunks: [], 
            stream: null 
        });
        
        if (activeStream) {
            activeStream.getTracks().forEach(track => track.stop());
        }
        
        this.updateBtn();
    }

    stopRecording() {
        if (this.recorder) {
            this.recorder.onstop = () => this.cleanup();
            try {
                this.recorder.stop();
            } catch (error) {
                this.cleanup();
            }
        }
    }

    async stopAndTranscribe() {
        if (!this.recorder) return;

        const currentTabId = this.recordingTabId;
        const currentMimeType = this.mimeType || this.recorder.mimeType || 'audio/webm';
        
        const audioBlob = await new Promise(resolve => {
            this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: currentMimeType }));
            this.recorder.stop();
        });

        this.cleanup();
        if (!audioBlob.size) return;

        const transcriptionModel = this.state.getSetting('transcription_model');
        if (!transcriptionModel) {
            return this.onError('Select transcription model in settings.');
        }

        this.busy = true;
        this.updateBtn();

        try {
            const fileExtension = ['ogg', 'webm', 'wav', 'mp3'].find(ext => audioBlob.type.includes(ext)) || 'webm';
            const transcriptionResult = await this.api.transcribeAudio(transcriptionModel, audioBlob, { filename: `audio.${fileExtension}` });
            
            if (transcriptionResult) {
                this.onTranscript(currentTabId, transcriptionResult);
            }
        } catch (error) {
            this.onError(this.api.getUiErrorMessage(error, { prefix: 'Transcription error' }));
        } finally {
            this.busy = false;
            this.updateBtn();
        }
    }

    handleTabClose(tabId) {
        if (this.recordingTabId === tabId) {
            this.stopRecording();
        }
    }

    handleTabSwitch(tabId, oldTabId) {
        if (this.recordingTabId === oldTabId) {
            this.stopAndTranscribe();
        }
    }
}
