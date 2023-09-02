# Faster ChatGPT Chrome Extension

Faster ChatGPT is a Chrome Extension that \*wraps\* the OpenAI API to enable 1 click answers.  
## Why is this useful?
- Whenever I browse the web, questions or unclarities arise **constantly**. Now instead of ignoring them, I can learn.
- You get an answer (with a tailored prompt) in 3 seconds instead of 30, or never even bothering in the first place.  
- Googling, or copying and pasting into ChatGPT, and then making a good prompt takes way too long. 

## Installation Guide
1. Download this repo as a ZIP.
2. Unzip and put it somewhere, where it will stay (don't delete it).
3. Go to the extensions page in Chrome and enable Developer options.
4. Either drag and drop it, or click "Load Unpacked" and select this folder.
5. Open the extension popup, go to settings, and input your OpenAI API key.

## How to use
- To select text of interest, hold **CTRL** while selecting, the Side Panel will pop up once you release your mouse. To close, just click away to remove the selection.
- You can specify (in settings) if you want to get a response instantly, or if you want to add a prompt first.
- Customize your Prompt! I have included a default one, but I'm sure you can get better results by adding profile information or other tailored instructions.
- For anything to work, you will need to specify your OpenAI API key.
- You can switch in settings to GPT 4 or GPT 3.5 mid prompt. I'd default to 3.5 and only use GPT 4 when 3.5 is too weak, as GPT 4 is 10x more expensive (it really is wayyy better though). Also, make sure you actually have access to GPT 4 in that case.

# Security Notice
Your OpenAI API key will be visible in the browser, including places like the Network tab of the developer console during API requests or within JavaScript variables at runtime. I never have access to your API key, but if you have concerns about its visibility, please refrain from using this extension. If you have suggestions for improving this, kindly submit a pull request with your proposed changes.

## Notes
- Right now, only Chrome from version 116 is supported, as that is the first version with which you can open the side panel programmatically (0 clicks).
- I might add this to the Chrome extension store at some point, but for now, just install it this way.

## Contribute
I got what I wanted from this project, which is faster useful information access.  
If you want to improve some things (which would be awesome), I suggest adding multiple prompts to switch between, or fixing the API key visibility.