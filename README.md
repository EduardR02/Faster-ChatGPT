# Faster ChatGPT Chrome Extension

Faster ChatGPT is a Chrome Extension that \*wraps\* the OpenAI/Anthropic/Gemini API to enable 1 click answers.  

## Basic Chat Example
![Basic chat example](images\Start_Panel.PNG)  

![Basic regenerate example](images\regenerate.PNG)

## Arena Mode Example
![Arena mode example](images\strawberry_arena.PNG)

![Arena mode resolved](images\Arena_resolved.PNG)

## Basic Selection with Instant Prompt Example
![Basic selection example](images\InstantPrompt.PNG)

## Why is this useful?
- Whenever I browse the web, questions or unclarities arise **constantly**. Now instead of ignoring them, I can learn.
- You get an answer (with a tailored prompt) in 3 seconds instead of 30, or never even bothering in the first place.  
- Googling, or copying and pasting into ChatGPT/Claude, and then making a good prompt takes way too long. 
- Having a custom prompt and temperature control makes refusals much less likely and the answers much better.

## Installation Guide
You can install this extension from the Chrome Web Store [here](https://chromewebstore.google.com/detail/sidekick-llm/nlpcdeggdeeopcpeeopbjmmkeahojaod)

## TLDR features
- Now also supports images, and even multiple images per message (drag and drop or paste, so far only Claude and OpenAI, Gemini will just ignore them).
- Regenerate response as many times as you like
- Switch model mid conversation, you can even switch to regenerate a response with a new model.
- Arena Mode personal ranking for your exact use cases.
- Can switch between Arena and normal mode between responses.
- Chat mode, opened through popup (with different prompt).
- Thinking mode to let the model plan.

## Manual Installation
1. Download this repo as a ZIP.
2. Unzip and put it somewhere, where it will stay (don't delete it).
3. Go to the extensions page in Chrome and enable Developer options.
4. Either drag and drop it, or click "Load Unpacked" and select this folder.
5. Open the extension popup, go to settings, and input your API keys (minimum for the model you want to use).

## How to use
- To select text of interest, hold **CTRL** while selecting, the Side Panel will pop up once you release your mouse. To close, just click away to remove the selection.
- If you want to use images in your prompt, simply drag and drop or copy paste them into the prompt box. You can also use multiple images per message.
- You can specify (in the popup) if you want to get a response instantly, or if you want to add a prompt first.
- Customize your Prompt! I have included a default one, but I'm sure you can get better results by adding profile information or other tailored instructions.
- For anything to work, you will need to specify your API keys.
- You can switch in settings between models mid conversation. I'd default to 4o-mini, which is becoming too cheap to meter. Since I also added Anthropic API I'm using Sonnet 3.5 which is amazing, while 4o and much more so 4o-mini are slop machines lately (LMSYS says they're great though, sus).
- You can now also customize a few settings like keeping the side panel open and streaming the response.
- If you just want to chat, you can open chat mode from the popup (make sure to add a chat prompt).

## Arena Mode
- Why? Because it's fun. Also (we will see) seems useful for personal ranking, as it's exactly the users usual use case and also LMSYS seems less good lately.
- You can now activate Arena Mode in settings, and get two responses at once, like LMSYS Chatbot arena.
- Vote for which output you like best. Giveaways like input token count and (obviously) model names are hidden until you make a choice.
- Voting is intended to mean the following things:
    - Voting for either model will count as a "win" and the conversation continues (with the next random models)
    - Voting for draw will update the elo points for draw, and choose randomly between both model outputs to continue the conversation.
    - Voting for "None"/"Discard" will not count towards rating and discard both responses before continuing with new models for **the same** prompt.
    - Not voting and sending a new prompt will not update rating and choose an output randomly to continue the conversation.
- After a choice the conversation (for now) continues with newly chosen random models.
- You can individually regenerate responses!

## Thinking Mode
- Inspired by o1 release, we let the model run in a while loop so it can "think" longer
- We append an additional prompt to the system prompt, which tells the model that it either:
    - Should exclusively do the thinking. You **must** make it clear to the model that it must append "\*\*continue\*\*" to its response if it wants to "think" more.
    - Should use the thought process to generate the final response - the solution.
- Regenerating works nicely with this, you can toggle thinking mode on and off, and also change the model if you don't like the output.

## Arena TODO
- LMSYS does not use the standard elo algorithm because it is biased towards later results, even though LLMs are "supposed to be" static. Might implement that. The problem is that for the local use case you have very low sample size, so might not matter that much.
- Maybe should add setting that fixes the models for a single arena session, but just shuffles left right (already does that anyway).
- Because gemini streaming is different (and much slower) it's a giveaway (also it often uses double spaces often for some reason and ends with double new line sometimes), so either nerf the other models' streaming or idk, does not bother me that much tbh.

# Security Notice
Your API keys will be visible in the browser, including places like the Network tab of the developer console during API requests or within JavaScript variables at runtime. I never have access to your API key, but if you have concerns about its visibility, please refrain from using this extension (or use API keys with little credits which you are not afraid to lose). If you have suggestions for improving this, kindly submit a pull request with your proposed changes.

## Notes
- Right now, only Chrome from version 116 is supported, as that is the first version with which you can open the side panel programmatically (0 clicks).
- Doesn't work on some things like pdfs, or (very rarely) some sites with weird text selection because you can't get access to the selection. Might fix...

## Contribute
I got what I wanted from this project, which is faster useful information access.  
If you want to improve some things (which would be awesome), I suggest adding multiple prompts to switch between, or fixing the API key visibility.