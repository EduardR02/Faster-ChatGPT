import { test } from 'bun:test';
import assert from 'assert';
import { sanitizeBase64Image, base64NeedsRepair } from '../../src/js/image_utils.js';

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

test('image_utils clean base image', () => {
    assert.strictEqual(base64NeedsRepair(basePng, 'image/png'), false, 'Clean base image should not need repair');
    assert.strictEqual(sanitizeBase64Image(basePng, 'image/png'), basePng, 'Clean base image should stay unchanged');
});

test('image_utils repair base64 images', () => {
    for (const { name, input, expect } of fixtures) {
        assert.strictEqual(base64NeedsRepair(input, 'image/png'), true, `${name}: should detect need for repair`);
        assert.strictEqual(sanitizeBase64Image(input, 'image/png'), expect, `${name}: sanitized output should strip trailing text`);
    }
});

test('image_utils handles JPEG mime type', () => {
    // JPEG doesn't have a specific trailer like PNG
    const jpeg = 'iVBORw0KGgo='; // Not a real JPEG, just for testing
    assert.strictEqual(base64NeedsRepair(jpeg, 'image/jpeg'), false, 'Clean base64 JPEG should not need repair');
});

test('image_utils handles base64 with invalid characters', () => {
    const invalid = 'iVBORw0KGgo===!!!invalid';
    assert.strictEqual(base64NeedsRepair(invalid, 'image/png'), true);
});

test('image_utils handles empty string', () => {
    assert.strictEqual(base64NeedsRepair('', 'image/png'), true);
});

test('image_utils handles very long corrupted base64', () => {
    const longCorrupted = basePng + 'A'.repeat(10000) + ' trailing garbage';
    assert.strictEqual(base64NeedsRepair(longCorrupted, 'image/png'), true);
    const sanitized = sanitizeBase64Image(longCorrupted, 'image/png');
    assert.strictEqual(sanitized, basePng);
});

