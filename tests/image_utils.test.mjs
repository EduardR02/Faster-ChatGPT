import assert from 'assert';
import { sanitizeBase64Image, base64NeedsRepair } from '../src/js/image_utils.js';

// Polyfill atob/btoa for Node
if (typeof atob === 'undefined') {
    globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
}
if (typeof btoa === 'undefined') {
    globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
}

const basePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwIB/AL+X1EAAAAASUVORK5CYII=';

const fixtures = [
    { name: 'kSuQmCC appended sentence', input: `${basePng}Here you go. It sounds like you're aiming for a visual representation of knowledge and its profound, almost cosmic, influence, all while keeping it aesthetically captivating.`, expect: basePng },
    { name: 'AElFTkSuQmCC appended description', input: `${basePng}Here’s your ethereal cosmic sidekick scene. The glowing knowledge streaks, the intricate circuit board patterns, and the black hole with its accretion disk are all there.`, expect: basePng },
    { name: 'U5ErkJggg== wow prompt', input: `${basePng}Wow, that's quite a prompt. Here's your image:`, expect: basePng },
    { name: 'JRU5ErkJggg== initial thoughts', input: `${basePng}Initial thoughts: The core concept keeps talking for a while here`, expect: basePng },
    { name: '5CYII= Oppenmenker', input: `${basePng}There you go, "Oppenmenker" in all its fantastical glory.`, expect: basePng },
    { name: 'ElFTkSuQmCC Pixar text', input: `${basePng}Excellent, right out of a Pixar short film. The Wes Anderson symmetry is a nice touch, too. What's the story behind this guy's "Big Opportunity" application, I wonder?%20Looks%20like%20he%27s%20just%20stumbled%20into%20something%20monumental.`, expect: basePng },
    { name: 'AAAAElFTkSuQmCC Pixar variant', input: `${basePng}Excellent, right out of a Pixar short film. The Wes Anderson symmetry is a nice touch, too. What's the story behind this guy's "Big Opportunity" application, I wonder?%20Looks%20like%20he%27s%20just%20stumbled%20into%20something%20monumental.`, expect: basePng },
    { name: 'Thereyougo== compact', input: `${basePng}Thereyougo==`, expect: basePng },
    { name: 'Initialthoughts=', input: `${basePng}Initialthoughts=`, expect: basePng },
    { name: 'Wow=', input: `${basePng}Wow=`, expect: basePng },
];

assert.strictEqual(base64NeedsRepair(basePng, 'image/png'), false, 'Clean base image should not need repair');
assert.strictEqual(sanitizeBase64Image(basePng, 'image/png'), basePng, 'Clean base image should stay unchanged');

for (const { name, input, expect } of fixtures) {
    assert.strictEqual(base64NeedsRepair(input, 'image/png'), true, `${name}: should detect need for repair`);
    assert.strictEqual(sanitizeBase64Image(input, 'image/png'), expect, `${name}: sanitized output should strip trailing text`);
}

console.log('image_utils tests passed');
