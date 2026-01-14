export class DragDropManager {
    constructor(dropAreaElement, callbacks) { 
        Object.assign(this, { area: dropAreaElement, ...callbacks }); 
        this.init(); 
    }

    init() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventType => {
            this.area.addEventListener(eventType, event => {
                event.preventDefault(); 
                event.stopPropagation();
                
                this.area.classList.toggle('dragging', ['dragover', 'dragenter'].includes(eventType));
                
                if (eventType === 'drop') {
                    this.handleDrop(event);
                }
            });
        });

        this.area.onpaste = event => { 
            const clipboardItems = Array.from(event.clipboardData?.items || []);
            const files = clipboardItems
                .filter(item => item.kind === 'file')
                .map(item => item.getAsFile())
                .filter(Boolean);
            
            if (files.length > 0) { 
                event.preventDefault(); 
                this.handleFiles(files); 
            } 
        };
    }

    async handleDrop(event) {
        const dataTransfer = event.dataTransfer; 
        if (dataTransfer.files.length > 0) {
            return this.handleFiles(dataTransfer.files);
        }

        const htmlContent = dataTransfer.getData('text/html'); 
        if (htmlContent) { 
            const parsedDocument = new DOMParser().parseFromString(htmlContent, 'text/html');
            const imageElement = parsedDocument.querySelector('img');
            const imageSource = imageElement?.src;
            
            if (imageSource) { 
                const base64String = await this.urlToBase64(imageSource); 
                if (base64String) {
                    return this.onImage(base64String); 
                }
            } 
        }

        const droppedText = dataTransfer.getData('text'); 
        if (droppedText) { 
            const { selectionStart, selectionEnd, value } = this.area; 
            const newValue = value.slice(0, selectionStart) + droppedText + value.slice(selectionEnd);
            this.onText(newValue); 
        }
    }

    async handleFiles(files) {
        for (const file of Array.from(files)) {
            const fileReader = new FileReader();
            
            if (file.type.startsWith('image/')) { 
                fileReader.onload = event => this.onImage(event.target.result); 
                fileReader.readAsDataURL(file); 
            } else if (!file.type.startsWith('video/')) { 
                fileReader.onload = event => this.onFile({ name: file.name, content: event.target.result }); 
                fileReader.onerror = event => this.onError(event); 
                fileReader.readAsText(file); 
            }
        }
    }

    async urlToBase64(url, maxBytes = 20_000_000) {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 8000);

        try {
            const response = await fetch(url, { signal: abortController.signal });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            // Check Content-Length header first to avoid downloading large images
            const contentLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                throw new Error('image too large');
            }

            const responseBlob = await response.blob();
            if (responseBlob.size > maxBytes) {
                throw new Error('image too large');
            }

            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = event => resolve(event.target.result);
                reader.readAsDataURL(responseBlob);
            });
        } catch (error) {
            const errorMessage = error.name === 'AbortError' ? 'Image fetch timed out' : `Error: ${error.message}`;
            this.onError(errorMessage);
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}