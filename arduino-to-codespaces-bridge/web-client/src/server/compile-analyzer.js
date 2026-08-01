/**
 * Compile Error Analyzer (dev-server mirror)
 *
 * Runtime ESM mirror of src/server/compileErrorAnalyzer.ts used by the
 * development web-client server (server.js). The extension ships the
 * TypeScript version; this copy keeps the local `npm run dev` experience
 * identical. test/compile-feedback.test.mjs asserts the two stay in lock-step.
 *
 * @module server/compile-analyzer
 */

const ERROR_LOCATION_RE =
  /([^\s:][^:\n]*\.(?:ino|pde|cpp|cc|cxx|c|hpp|hxx|hh|h)):(\d+):(\d+):\s*(?:fatal\s+)?error:\s*(.+)/i;

/**
 * Return the final path segment of a POSIX or Windows path.
 * @param {string} filePath - A file path, possibly absolute.
 * @returns {string} The file name without its directory.
 */
function basename(filePath) {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Collect every `file:line:col: error:` location in the log, in order.
 * @param {string} log - Raw compiler output.
 * @returns {{file:string,line:number,column:number,message:string}[]}
 */
function collectErrorLocations(log) {
  const out = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(ERROR_LOCATION_RE);
    if (!m) continue;
    out.push({
      file: basename(m[1]),
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      message: m[4].trim(),
    });
  }
  return out;
}

/**
 * Compose the standard one-line headline shown as the final terminal line.
 * @param {string} title - Short issue title.
 * @param {?{file?:string,line?:number,column?:number}} loc - Optional location.
 * @param {string} suggestion - Actionable fix appended after an arrow.
 * @returns {string} A single formatted line clearly identifying the issue.
 */
function makeHeadline(title, loc, suggestion) {
  const where =
    loc && loc.file && loc.line
      ? ` (${loc.file}:${loc.line}${loc.column ? `:${loc.column}` : ""})`
      : "";
  return `\u274c ${title}${where} \u2014 ${suggestion}`;
}

/**
 * Extract the reported memory usage percentage for an overflow message.
 * @param {string} log - Raw compiler output.
 * @param {"flash"|"ram"} kind - Which memory region to look for.
 * @returns {string} A short "(129%)" style fragment, or an empty string.
 */
function memoryUsageFragment(log, kind) {
  const re =
    kind === "flash"
      ? /program storage space.*?\((\d+)%\)|\((\d+)%\)\s+of\s+program/i
      : /dynamic memory.*?\((\d+)%\)|\((\d+)%\)\s+of\s+dynamic/i;
  const m = log.match(re);
  const pct = m && (m[1] || m[2]);
  return pct ? ` It currently needs ${pct}% of the available space.` : "";
}

/**
 * Classify a single compiler error message (with its location) into a friendly
 * diagnosis, so every distinct problem in a build can be reported.
 * @param {{file:string,line:number,column:number,message:string}} loc - One error.
 * @returns {object} A structured diagnosis for that single error.
 */
function classifyMessage(loc) {
  const { file, line, column, message } = loc;

  const header = message.match(
    /^([^\s:]+\.h(?:pp|xx)?)\s*:\s*No such file or directory/i,
  );
  if (header) {
    const h = header[1];
    const suggestion = `Install the library that provides <${h}> from the Library Manager, or fix the #include spelling.`;
    return {
      category: "missing_header",
      title: "Missing library / header file",
      file,
      line,
      column,
      message: `${h}: No such file or directory`,
      explanation: `The compiler could not find "${h}". Either the library is not installed, or the file name is misspelled.`,
      suggestion,
      headline: makeHeadline("Missing library / header file", loc, suggestion),
    };
  }

  if (/^expected\s*(?:'[,;]'|',' or ';'|';')\s*before/i.test(message)) {
    const beforeLine = line > 1 ? line - 1 : line;
    const suggestion = `Add a semicolon (;) to the end of the statement, most likely on line ${beforeLine}.`;
    return {
      category: "missing_semicolon",
      title: "Missing semicolon",
      file,
      line,
      column,
      message,
      explanation:
        "A statement is missing its closing semicolon. C++ needs a ; at the end of every statement.",
      suggestion,
      headline: makeHeadline("Missing semicolon", loc, suggestion),
    };
  }

  const redef = message.match(/^redefinition of '([^']+)'/i);
  if (redef) {
    const name = redef[1];
    const suggestion = `"${name}" is defined more than once. Delete or rename the duplicate copy.`;
    return {
      category: "redefinition",
      title: "Defined twice (redefinition)",
      file,
      line,
      column,
      message: `redefinition of '${name}'`,
      explanation: `"${name}" appears more than once. This often happens when setup() or loop() is accidentally pasted twice.`,
      suggestion,
      headline: makeHeadline("Defined twice (redefinition)", loc, suggestion),
    };
  }

  if (
    /expected '}' at end of input/i.test(message) ||
    /a function-definition is not allowed here/i.test(message)
  ) {
    const suggestion =
      "Check that every opening brace { has a matching closing brace }. A function is probably missing its closing }.";
    return {
      category: "unmatched_brace",
      title: "Unmatched curly brace",
      file,
      line,
      column,
      message,
      explanation:
        "The braces { } are not balanced. An opening { somewhere in your code was never closed.",
      suggestion,
      headline: makeHeadline("Unmatched curly brace", loc, suggestion),
    };
  }

  const array = message.match(/size of array '([^']+)' is too large/i);
  if (array) {
    const suggestion = `Make the array "${array[1]}" smaller, or store its data in flash with PROGMEM.`;
    return {
      category: "array_too_large",
      title: "Array is too large",
      file,
      line,
      column,
      message: `size of array '${array[1]}' is too large`,
      explanation: `The array "${array[1]}" is bigger than the memory available on this board.`,
      suggestion,
      headline: makeHeadline("Array is too large", loc, suggestion),
    };
  }

  const undecl = message.match(/^'([^']+)' was not declared in this scope/i);
  if (undecl) {
    const name = undecl[1];
    const suggestion = `Declare "${name}" before using it, check the spelling, or include the library that defines it.`;
    return {
      category: "undeclared_identifier",
      title: "Name not declared",
      file,
      line,
      column,
      message: `'${name}' was not declared in this scope`,
      explanation: `"${name}" is used before it is defined. It may be misspelled, missing a declaration, or need a library include.`,
      suggestion,
      headline: makeHeadline("Name not declared", loc, suggestion),
    };
  }

  const suggestion = `Read the compiler message above and fix the code at line ${line}.`;
  return {
    category: "compile_error",
    title: "Compilation error",
    file,
    line,
    column,
    message,
    explanation: `The compiler reported: ${message}`,
    suggestion,
    headline: makeHeadline("Compilation error", loc, suggestion),
  };
}

/**
 * Analyse a raw compile log and return a friendly diagnosis for every distinct
 * problem found, in the order the compiler reported them.
 * @param {?string} log - Raw combined stdout/stderr from an arduino-cli compile.
 * @returns {object[]} Zero or more diagnoses.
 */
export function analyzeCompileErrors(log) {
  if (!log || !log.trim()) return [];

  if (/text section exceeds available space|Sketch too big/i.test(log)) {
    const suggestion =
      "Your program is too large for this board's flash memory. Remove unused code/libraries or pick a board with more storage.";
    return [
      {
        category: "flash_overflow",
        title: "Program too big for the board",
        explanation:
          "The compiled sketch is larger than the flash (program) memory on the selected board." +
          memoryUsageFragment(log, "flash"),
        suggestion,
        headline: makeHeadline(
          "Program too big for the board",
          null,
          suggestion,
        ),
      },
    ];
  }

  if (/data section exceeds available space|Not enough memory/i.test(log)) {
    const suggestion =
      "Global variables use more RAM than the board has. Shrink arrays, or store constant strings/tables in flash with the F() macro or PROGMEM.";
    return [
      {
        category: "ram_overflow",
        title: "Not enough memory (RAM)",
        explanation:
          "The sketch's global variables need more dynamic memory (RAM) than the selected board provides." +
          memoryUsageFragment(log, "ram"),
        suggestion,
        headline: makeHeadline("Not enough memory (RAM)", null, suggestion),
      },
    ];
  }

  const missingFn = log.match(/undefined reference to [`']((?:setup|loop))'/i);
  if (missingFn) {
    const fn = missingFn[1];
    const suggestion = `Every Arduino sketch needs both void setup() and void loop(). Add the missing void ${fn}() { } function.`;
    return [
      {
        category: "missing_required_function",
        title: `Missing ${fn}() function`,
        message: `undefined reference to \`${fn}'`,
        explanation: `The sketch is missing the required void ${fn}() function that every Arduino program must have.`,
        suggestion,
        headline: makeHeadline(`Missing ${fn}() function`, null, suggestion),
      },
    ];
  }

  const results = [];
  const seen = new Set();
  for (const loc of collectErrorLocations(log)) {
    const diagnosis = classifyMessage(loc);
    const key = `${diagnosis.category}|${diagnosis.file}|${diagnosis.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(diagnosis);
    if (results.length >= 12) break;
  }
  if (results.length > 0) return results;

  if (
    /undefined reference to/i.test(log) ||
    /collect2:\s*error:\s*ld returned/i.test(log)
  ) {
    const undef = log.match(/undefined reference to [`']([^']+)'/i);
    const what = undef ? ` ("${undef[1]}")` : "";
    const suggestion =
      "A function or variable is used but never defined. Check for a missing definition or an uninstalled library.";
    return [
      {
        category: "linker_error",
        title: "Linker error",
        message: undef ? `undefined reference to \`${undef[1]}'` : undefined,
        explanation: `The code compiled but could not be linked${what}. Something is declared but its definition is missing.`,
        suggestion,
        headline: makeHeadline("Linker error", null, suggestion),
      },
    ];
  }

  if (/error/i.test(log)) {
    const suggestion =
      "Read the compiler output above for the specific error message.";
    return [
      {
        category: "unknown",
        title: "Compilation failed",
        explanation:
          "The build failed but the specific cause could not be identified automatically.",
        suggestion,
        headline: makeHeadline("Compilation failed", null, suggestion),
      },
    ];
  }

  return [];
}

/**
 * Analyse a raw compile log and return the primary (first) diagnosis, or null.
 * @param {?string} log - Raw combined stdout/stderr from an arduino-cli compile.
 * @returns {?object} The primary diagnosis, or null.
 */
export function analyzeCompileError(log) {
  return analyzeCompileErrors(log)[0] ?? null;
}
