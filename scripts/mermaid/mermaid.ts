import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

const OPERATOR_WORDS: Record<string, string> = {
  ">": "greater_than",
  "<": "less_than",
  "===": "equals",
  "!": "not",
  "&&": "and",
  "||": "or",
  "=": "is",
  "+=": "plus_is",
};

const DROPPED_KEYWORDS = new Set(["const", "let", "var", "await", "new"]);

const CONDITION_OPPOSITES: [string, string][] = [
  ["!==", "==="],
  ["===", "!=="],
  [">=", "<"],
  ["<=", ">"],
  [">", "<="],
  ["<", ">="],
];

interface StatementRecord {
  baseId: string;
  label: string;
}

interface Chain {
  topBox: { id: string; label: string } | null;
  statements: readonly ts.Node[];
}

interface WalkContext {
  importMap: Map<string, string>;
  totalCounts: Map<string, number>;
  runningCounts: Map<string, number>;
}

interface WalkOutcome {
  boxLines: string[];
  edgeLines: string[];
  openPaths: string[][];
}

function computeBaseId(statementText: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, statementText);
  const words: string[] = [];
  let tokenKind = scanner.scan();
  while (tokenKind !== ts.SyntaxKind.EndOfFileToken) {
    const tokenText = scanner.getTokenText();
    if (
      tokenKind === ts.SyntaxKind.Identifier ||
      tokenKind === ts.SyntaxKind.NumericLiteral ||
      tokenKind === ts.SyntaxKind.StringLiteral
    ) {
      words.push(tokenText);
    }
    else if (tokenKind === ts.SyntaxKind.ReturnKeyword) {
      words.push("return");
    }
    else if (tokenKind === ts.SyntaxKind.OfKeyword || tokenKind === ts.SyntaxKind.InKeyword) {
      words.push(tokenText);
    }
    else if (!DROPPED_KEYWORDS.has(tokenText) && OPERATOR_WORDS[tokenText] !== undefined) {
      words.push(OPERATOR_WORDS[tokenText]);
    }
    tokenKind = scanner.scan();
  }
  return words.join("_");
}

function computeOppositeCondition(conditionText: string): string {
  if (conditionText.startsWith("!")) {
    return conditionText.slice(1);
  }
  for (const [operator, opposite] of CONDITION_OPPOSITES) {
    if (conditionText.includes(operator)) {
      return conditionText.replace(operator, opposite);
    }
  }
  return `!(${conditionText})`;
}

function calleeName(node: ts.Node): string | null {
  let expression: ts.Expression | undefined;
  if (ts.isExpressionStatement(node)) {
    expression = node.expression;
  }
  else if (ts.isReturnStatement(node)) {
    expression = node.expression;
  }
  else if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    expression = node.declarationList.declarations[0].initializer;
  }
  if (expression !== undefined && ts.isAwaitExpression(expression)) {
    expression = expression.expression;
  }
  if (expression !== undefined && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return null;
}

function statementRecord(node: ts.Node, importMap: Map<string, string>): StatementRecord {
  const text = node.getText();
  const label = text.replace(/;\s*$/, "");
  const callee = calleeName(node);
  const specifier = callee !== null ? importMap.get(callee) : undefined;
  const finalLabel = specifier !== undefined ? `${label}<br/>${specifier}` : label;
  return { baseId: computeBaseId(text), label: finalLabel };
}

function branchStatements(node: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(node) ? node.statements : [node];
}

function collectBaseIds(statements: readonly ts.Node[], counts: Map<string, number>): void {
  for (const statement of statements) {
    if (ts.isIfStatement(statement)) {
      collectBaseIds(branchStatements(statement.thenStatement), counts);
      if (statement.elseStatement !== undefined) {
        collectBaseIds(branchStatements(statement.elseStatement), counts);
      }
      continue;
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement) || ts.isForStatement(statement)) {
      collectBaseIds(branchStatements(statement.statement), counts);
      continue;
    }
    const baseId = computeBaseId(statement.getText());
    counts.set(baseId, (counts.get(baseId) ?? 0) + 1);
  }
}

function assignFinalId(baseId: string, ctx: WalkContext): string {
  const total = ctx.totalCounts.get(baseId) ?? 0;
  const occurrence = (ctx.runningCounts.get(baseId) ?? 0) + 1;
  ctx.runningCounts.set(baseId, occurrence);
  return total > 1 ? `B_${baseId}${occurrence}` : `B_${baseId}`;
}

function walkStatements(entryPaths: string[][], statements: readonly ts.Node[], ctx: WalkContext): WalkOutcome {
  const boxLines: string[] = [];
  const edgeLines: string[] = [];
  let openPaths = entryPaths;

  for (const statement of statements) {
    if (ts.isIfStatement(statement)) {
      const conditionText = statement.expression.getText();
      const baseId = computeBaseId(conditionText);
      const diamondId = `Q_${baseId}`;
      const yesId = `Q_CHOICE_${baseId}_Y`;
      const noId = `Q_CHOICE_${baseId}_N`;
      boxLines.push(`${diamondId}{"if( ${conditionText} )"}`);
      boxLines.push(`${yesId}["${conditionText}"]`);
      boxLines.push(`${noId}["${computeOppositeCondition(conditionText)}"]`);

      for (const path of openPaths) {
        path.push(diamondId);
        edgeLines.push(path.join(" --> "));
      }

      const thenOutcome = walkStatements([[diamondId, yesId]], branchStatements(statement.thenStatement), ctx);
      boxLines.push(...thenOutcome.boxLines);
      edgeLines.push(...thenOutcome.edgeLines);

      const elseStatements = statement.elseStatement !== undefined ? branchStatements(statement.elseStatement) : [];
      const elseOutcome = walkStatements([[diamondId, noId]], elseStatements, ctx);
      boxLines.push(...elseOutcome.boxLines);
      edgeLines.push(...elseOutcome.edgeLines);

      openPaths = [...thenOutcome.openPaths, ...elseOutcome.openPaths];
      continue;
    }

    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const loopVariable = ts.isVariableDeclarationList(statement.initializer)
        ? statement.initializer.declarations[0].name.getText()
        : statement.initializer.getText();
      const iterableText = statement.expression.getText();
      const joinWord = ts.isForOfStatement(statement) ? "of" : "in";
      const headerText = `for (${statement.initializer.getText()} ${joinWord} ${iterableText})`;
      const idPart = `for_${computeBaseId(headerText)}`;
      const diamondId = `Q_${idPart}`;
      const yesId = `Q_CHOICE_${idPart}_Y`;
      const noId = `Q_CHOICE_${idPart}_N`;
      boxLines.push(`${diamondId}{"${headerText}"}`);
      boxLines.push(`${yesId}["i < ${iterableText}.length; ${loopVariable} = ${iterableText}[i];"]`);
      boxLines.push(`${noId}["i >= ${iterableText}.length"]`);

      for (const path of openPaths) {
        path.push(diamondId);
        edgeLines.push(path.join(" --> "));
      }

      const bodyOutcome = walkStatements([[diamondId, yesId]], branchStatements(statement.statement), ctx);
      boxLines.push(...bodyOutcome.boxLines);
      edgeLines.push(...bodyOutcome.edgeLines);
      for (const path of bodyOutcome.openPaths) {
        path.push(diamondId);
        edgeLines.push(path.join(" --> "));
      }

      openPaths = [[diamondId, noId]];
      continue;
    }

    if (ts.isForStatement(statement)) {
      const initText = statement.initializer !== undefined ? statement.initializer.getText() : "";
      const conditionText = statement.condition !== undefined ? statement.condition.getText() : "";
      const incrementorText = statement.incrementor !== undefined ? statement.incrementor.getText() : "";
      const headerText = `for (${initText}; ${conditionText}; ${incrementorText})`;
      const idPart = `for_${computeBaseId(headerText)}`;
      const diamondId = `Q_${idPart}`;
      const yesId = `Q_CHOICE_${idPart}_Y`;
      const noId = `Q_CHOICE_${idPart}_N`;
      boxLines.push(`${diamondId}{"${headerText}"}`);
      boxLines.push(`${yesId}["${conditionText}"]`);
      boxLines.push(`${noId}["${computeOppositeCondition(conditionText)}"]`);

      for (const path of openPaths) {
        path.push(diamondId);
        edgeLines.push(path.join(" --> "));
      }

      const bodyOutcome = walkStatements([[diamondId, yesId]], branchStatements(statement.statement), ctx);
      boxLines.push(...bodyOutcome.boxLines);
      edgeLines.push(...bodyOutcome.edgeLines);
      for (const path of bodyOutcome.openPaths) {
        path.push(diamondId);
        edgeLines.push(path.join(" --> "));
      }

      openPaths = [[diamondId, noId]];
      continue;
    }

    const record = statementRecord(statement, ctx.importMap);
    const finalId = assignFinalId(record.baseId, ctx);
    boxLines.push(`${finalId}["${record.label}"]`);

    const isTerminal = ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
    for (const path of openPaths) {
      path.push(finalId);
    }
    if (openPaths.length > 1 || isTerminal) {
      for (const path of openPaths) {
        edgeLines.push(path.join(" --> "));
      }
      openPaths = isTerminal ? [] : [[finalId]];
    }
  }

  return { boxLines, edgeLines, openPaths };
}

function paramsText(parameters: readonly ts.ParameterDeclaration[]): string {
  return parameters.map((parameter) => parameter.getText()).join(", ");
}

function functionBodyChain(topBoxId: string, topBoxLabel: string, body: ts.Block, importMap: Map<string, string>): Chain[] {
  if (body.statements.length === 0) {
    return [];
  }
  return [{ topBox: { id: topBoxId, label: topBoxLabel }, statements: body.statements }];
}

function functionLikeChains(statement: ts.Statement, importMap: Map<string, string>): Chain[] | null {
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    return functionBodyChain(`B_${statement.name.text}`, `${statement.name.text}(${paramsText(statement.parameters)})`, statement.body, importMap);
  }
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    const declaration = declarations.length === 1 ? declarations[0] : null;
    const initializer = declaration?.initializer;
    if (declaration && ts.isIdentifier(declaration.name) && initializer && ts.isArrowFunction(initializer)) {
      const name = declaration.name.text;
      const topBoxId = `B_${name}`;
      const topBoxLabel = `${name}(${paramsText(initializer.parameters)})`;
      if (ts.isBlock(initializer.body)) {
        return functionBodyChain(topBoxId, topBoxLabel, initializer.body, importMap);
      }
      return [{ topBox: { id: topBoxId, label: topBoxLabel }, statements: [initializer.body] }];
    }
    return null;
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    const className = statement.name.text;
    const chains: Chain[] = [];
    for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
        chains.push(...functionBodyChain(`B_${className}_${member.name.text}`, `${className}::${member.name.text}(${paramsText(member.parameters)})`, member.body, importMap));
      }
    }
    return chains;
  }
  return null;
}

function relativeImportMap(sourceFile: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    const specifier = moduleSpecifier.text;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      continue;
    }
    const defaultName = statement.importClause?.name;
    if (defaultName !== undefined) {
      map.set(defaultName.text, specifier);
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      map.set(element.name.text, specifier);
    }
  }
  return map;
}

export function mermaidForFile(relativePath: string, sourceText: string): string {
  const fileBoxId = "B_" + relativePath.replace(/[^A-Za-z0-9_]/g, "_");
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const importMap = relativeImportMap(sourceFile);

  const chains: Chain[] = [];
  const fileChainStatements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue;
    }
    const functionChains = functionLikeChains(statement, importMap);
    if (functionChains !== null) {
      chains.push(...functionChains);
      continue;
    }
    fileChainStatements.push(statement);
  }
  if (fileChainStatements.length > 0) {
    chains.push({ topBox: null, statements: fileChainStatements });
  }

  const totalCounts = new Map<string, number>();
  for (const chain of chains) {
    collectBaseIds(chain.statements, totalCounts);
  }

  const ctx: WalkContext = { importMap, totalCounts, runningCounts: new Map() };
  const boxLines: string[] = [];
  const edgeLines: string[] = [];
  for (const chain of chains) {
    const startId = chain.topBox !== null ? chain.topBox.id : fileBoxId;
    if (chain.topBox !== null) {
      boxLines.push(`${chain.topBox.id}["${chain.topBox.label}"]`);
    }
    const outcome = walkStatements([[startId]], chain.statements, ctx);
    boxLines.push(...outcome.boxLines);
    edgeLines.push(...outcome.edgeLines);
    for (const path of outcome.openPaths) {
      if (path.length >= 2) {
        edgeLines.push(path.join(" --> "));
      }
    }
  }
  boxLines.sort();

  const lines = [`${fileBoxId}["${relativePath}"]`, ...boxLines, ...edgeLines];
  return `flowchart TD\n${lines.join("\n")}\n`;
}

export function writeAllDiagrams(repoRoot: string = process.cwd()): void {
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "*.ts"], { encoding: "utf8" });
  const files = tracked.split("\n").filter((line) => line.length > 0);
  for (const relativePath of files) {
    if (relativePath.endsWith(".test.ts")) {
      continue;
    }
    if (relativePath.startsWith("tests/")) {
      continue;
    }
    const sourceText = readFileSync(join(repoRoot, relativePath), "utf8");
    const diagramPath = join(repoRoot, ".taskTools", "diagrams", relativePath.replace(/\.ts$/, ".mmd"));
    mkdirSync(dirname(diagramPath), { recursive: true });
    writeFileSync(diagramPath, mermaidForFile(relativePath, sourceText));
  }
}

if (process.argv[1]?.endsWith("mermaid.ts")) {
  writeAllDiagrams();
}
