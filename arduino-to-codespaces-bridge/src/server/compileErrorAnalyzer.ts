/**
 * Compile Error Analyzer
 *
 * Pure functions that turn a raw arduino-cli / avr-gcc compile log into a
 * single, clearly-formatted diagnosis. The Arduino CLI ends every failed
 * build with the unhelpful `Error during build: exit status 1`; the real,
 * actionable message is printed several lines above it. This module scans the
 * log for the common beginner mistakes, extracts the offending file, line and
 * column, and produces a plain-language explanation plus a concrete fix.
 *
 * Kept free of any vscode/server dependencies so the exact logic the extension
 * ships can be exercised by the automated test suite
 * (test/compile-feedback.test.mjs) against both canned logs and live compiles.
 *
 * @module server/compileErrorAnalyzer
 */

/** A structured, human-friendly diagnosis of a failed compilation. */
export interface CompileDiagnosis {
  /** Stable machine-readable category id (e.g. "missing_semicolon"). */
  category: string;
  /** Short human title (e.g. "Missing semicolon"). */
  title: string;
  /** Basename of the offending source file, when known. */
  file?: string;
  /** 1-based line number of the offending code, when known. */
  line?: number;
  /** 1-based column number of the offending code, when known. */
  column?: number;
  /** The concise raw compiler message the diagnosis was derived from. */
  message?: string;
  /** Plain-language description of what went wrong. */
  explanation: string;
  /** Concrete, actionable step to fix the problem. */
  suggestion: string;
  /** Single formatted line summarising the issue for the terminal. */
  headline: string;
}

/** A source location parsed from a `file:line:col:` compiler prefix. */
interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/**
 * Matches the GCC `path:line:col: error:` prefix on a source file. The path is
 * captured loosely (anything up to the first `:` group) but must end in a
 * recognised C/C++/Arduino source extension so we never latch onto a message
 * that merely contains a colon.
 */
const ERROR_LOCATION_RE =
  /([^\s:][^:\n]*\.(?:ino|pde|cpp|cc|cxx|c|hpp|hxx|hh|h)):(\d+):(\d+):\s*(?:fatal\s+)?error:\s*(.+)/i;

/**
 * Collect every `file:line:col: error:` location in the log, in the order the
 * compiler reported them.
 *
 * @param log Raw compiler output.
 * @returns One entry per reported error line.
 */
function collectErrorLocations(
  log: string,
): (SourceLocation & { message: string })[] {
  const out: (SourceLocation & { message: string })[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(ERROR_LOCATION_RE);
    if (!m) {
      continue;
    }
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
 * Return the final path segment of a POSIX or Windows path.
 *
 * @param filePath A file path, possibly absolute.
 * @returns The file name without its directory.
 */
function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Compose the standard one-line headline shown as the final terminal line.
 *
 * @param title Short issue title.
 * @param loc Optional source location.
 * @param suggestion Actionable fix appended after an arrow.
 * @returns A single formatted line clearly identifying the issue.
 */
function makeHeadline(
  title: string,
  loc: Partial<SourceLocation> | null,
  suggestion: string,
): string {
  const where =
    loc && loc.file && loc.line
      ? ` (${loc.file}:${loc.line}${loc.column ? `:${loc.column}` : ""})`
      : "";
  return `\u274c ${title}${where} \u2014 ${suggestion}`;
}

/**
 * Extract the reported memory usage percentage for an overflow message so the
 * suggestion can quote how far over the limit the sketch is.
 *
 * @param log Raw compiler output.
 * @param kind Which memory region to look for.
 * @returns A short "(129%)" style fragment, or an empty string.
 */
function memoryUsageFragment(log: string, kind: "flash" | "ram"): string {
  const re =
    kind === "flash"
      ? /program storage space.*?\((\d+)%\)|\((\d+)%\)\s+of\s+program/i
      : /dynamic memory.*?\((\d+)%\)|\((\d+)%\)\s+of\s+dynamic/i;
  const m = log.match(re);
  const pct = m && (m[1] || m[2]);
  return pct ? ` It currently needs ${pct}% of the available space.` : "";
}

/**
 * Classify a single compiler error message (with its known location) into a
 * friendly diagnosis. Used for the per-line pass so every distinct problem in
 * a build is reported, not just the first one.
 *
 * @param loc The source location and raw message of one error line.
 * @returns A structured diagnosis for that single error.
 */
function classifyMessage(
  loc: SourceLocation & { message: string },
): CompileDiagnosis {
  const { file, line, column, message } = loc;

  // Missing header / library (fatal include failure).
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

  // Missing semicolon (GCC reports the next token's position).
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

  // Redefinition (e.g. setup/loop pasted twice).
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

  // Unmatched / missing brace.
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

  // Array too large for the board.
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

  // Undeclared identifier.
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

  // Generic C++ error with a location.
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
 *
 * Whole-build failures (memory overflow, a missing required function, a linker
 * error) are terminal summaries and are returned as the single item they are.
 * Otherwise each `file:line:col: error:` line is classified independently and
 * de-duplicated by category and location, so a sketch with several mistakes
 * surfaces them all.
 *
 * @param log Raw combined stdout/stderr from an arduino-cli compile.
 * @returns Zero or more diagnoses; empty when nothing actionable is found.
 */
export function analyzeCompileErrors(
  log: string | undefined | null,
): CompileDiagnosis[] {
  if (!log || !log.trim()) {
    return [];
  }

  // --- Memory: flash / program storage overflow ---------------------------
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

  // --- Memory: RAM / dynamic memory overflow ------------------------------
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

  // --- Linker: missing required setup()/loop() ----------------------------
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

  // --- Per-line source errors (there may be several) ----------------------
  const results: CompileDiagnosis[] = [];
  const seen = new Set<string>();
  for (const loc of collectErrorLocations(log)) {
    const diagnosis = classifyMessage(loc);
    const key = `${diagnosis.category}|${diagnosis.file}|${diagnosis.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(diagnosis);
    if (results.length >= 12) {
      break;
    }
  }
  if (results.length > 0) {
    return results;
  }

  // --- Linker: generic ----------------------------------------------------
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

  // --- Unrecognised failure -----------------------------------------------
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
 * Analyse a raw compile log and return the primary (first) diagnosis, or null
 * when the log contains no recognised failure. Convenience wrapper around
 * {@link analyzeCompileErrors} for callers that only need the headline issue.
 *
 * @param log Raw combined stdout/stderr from an arduino-cli compile.
 * @returns The primary diagnosis, or null when nothing actionable is found.
 */
export function analyzeCompileError(
  log: string | undefined | null,
): CompileDiagnosis | null {
  return analyzeCompileErrors(log)[0] ?? null;
}

/**
 * Render a diagnosis as a multi-line, boxed terminal block so the final output
 * is unmistakably the issue rather than the generic `exit status 1` line.
 *
 * @param diagnosis A diagnosis produced by {@link analyzeCompileError}.
 * @returns A ready-to-print block using `\n` line separators.
 */
export function formatDiagnosisBlock(diagnosis: CompileDiagnosis): string {
  const rule = "\u2500".repeat(60);
  const lines: string[] = [
    rule,
    `\u274c COMPILATION FAILED \u2014 ${diagnosis.title}`,
  ];
  if (diagnosis.file && diagnosis.line) {
    const col = diagnosis.column ? `, column ${diagnosis.column}` : "";
    lines.push(`   Location: ${diagnosis.file}, line ${diagnosis.line}${col}`);
  }
  lines.push(`   ${diagnosis.explanation}`);
  lines.push(`   \ud83d\udc49 ${diagnosis.suggestion}`);
  lines.push(rule);
  return lines.join("\n");
}
