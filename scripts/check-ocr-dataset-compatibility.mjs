import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Read the static fixture declarations without executing either revision's code.
export function readOcrCases(source) {
    const tree = ts.createSourceFile('ocr-cases.ts', source, ts.ScriptTarget.Latest, true);
    let declaration;
    for (const statement of tree.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        declaration = statement.declarationList.declarations.find((entry) => entry.name.getText(tree) === 'ocrCases') || declaration;
    }
    if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) throw new Error('ocrCases must be a static array.');
    const names = new Set();
    return declaration.initializer.elements.map((element) => {
        if (!ts.isObjectLiteralExpression(element)) throw new Error('Every OCR case must be a static object.');
        const result = {};
        for (const property of element.properties) {
            if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
                throw new Error('OCR case properties must have literal names and values.');
            }
            const value = property.initializer;
            if (!ts.isStringLiteral(value) && !ts.isNumericLiteral(value)) throw new Error('OCR case values must be string or number literals.');
            result[property.name.text] = ts.isStringLiteral(value) ? value.text : Number(value.text);
        }
        for (const key of ['name', 'image', 'expectedText']) {
            if (typeof result[key] !== 'string' || !result[key]) throw new Error(`OCR case requires ${key}.`);
        }
        if (names.has(result.name)) throw new Error(`Duplicate OCR case: ${result.name}`);
        names.add(result.name);
        return result;
    });
}

export async function checkDatasetCompatibility(baselineRoot, candidateRoot) {
    const load = async (root) => readOcrCases(await fs.readFile(path.join(root, 'tests', 'ocr-cases.ts'), 'utf8'));
    const [baseline, candidate] = await Promise.all([load(baselineRoot), load(candidateRoot)]);
    if (!baseline.length) throw new Error('Baseline OCR dataset must not be empty.');
    const candidates = new Map(candidate.map((entry) => [entry.name, entry]));
    for (const before of baseline) {
        const after = candidates.get(before.name);
        if (!after) throw new Error(`Baseline OCR case was removed: ${before.name}`);
        for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[field] !== after[field]) throw new Error(`${before.name}: ${field} changed; baseline labels and input settings must be preserved.`);
        }
        const [beforeHash, afterHash] = await Promise.all([
            imageHash(baselineRoot, before.image), imageHash(candidateRoot, after.image),
        ]);
        if (beforeHash !== afterHash) throw new Error(`${before.name}: fixture image bytes changed; baseline inputs must be preserved.`);
    }
    return { baselineCases: baseline.length, addedCases: candidate.filter((entry) => !baseline.some((before) => before.name === entry.name)).length };
}

async function imageHash(root, image) {
    const fixtureRoot = path.resolve(root, 'tests', 'fixtures');
    const filePath = path.resolve(fixtureRoot, image);
    if (!filePath.startsWith(`${fixtureRoot}${path.sep}`)) throw new Error(`OCR fixture is outside tests/fixtures: ${image}`);
    return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        if (process.argv.length !== 4) throw new Error('Usage: node scripts/check-ocr-dataset-compatibility.mjs BASELINE_ROOT CANDIDATE_ROOT');
        const result = await checkDatasetCompatibility(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
        console.log(`Preserved ${result.baselineCases} baseline OCR cases; ${result.addedCases} added cases will run against both builds.`);
    } catch (error) {
        console.error(`Invalid OCR dataset comparison: ${error.message}`);
        process.exitCode = 1;
    }
}
