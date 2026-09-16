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

interface StatementRecord {
  baseId: string;
  label: string;
}

interface Chain {
  topBox: { id: string; label: string } | null;
  statements: StatementRecord[];
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
    else if (!DROPPED_KEYWORDS.has(tokenText) && OPERATOR_WORDS[tokenText] !== undefined) {
      words.push(OPERATOR_WORDS[tokenText]);
    }
    tokenKind = scanner.scan();
  }
  return words.join("_");
}

function statementRecord(node: ts.Node): StatementRecord {
  const text = node.getText();
  return { baseId: computeBaseId(text), label: text.replace(/;\s*$/, "") };
}

function paramsText(parameters: readonly ts.ParameterDeclaration[]): string {
  return parameters.map((parameter) => parameter.getText()).join(", ");
}

function functionBodyChain(topBoxId: string, topBoxLabel: string, body: ts.Block): Chain[] {
  if (body.statements.length === 0) {
    return [];
  }
  return [{ topBox: { id: topBoxId, label: topBoxLabel }, statements: body.statements.map(statementRecord) }];
}

function functionLikeChains(statement: ts.Statement): Chain[] | null {
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    return functionBodyChain(`B_${statement.name.text}`, `${statement.name.text}(${paramsText(statement.parameters)})`, statement.body);
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
        return functionBodyChain(topBoxId, topBoxLabel, initializer.body);
      }
      return [{ topBox: { id: topBoxId, label: topBoxLabel }, statements: [statementRecord(initializer.body)] }];
    }
    return null;
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    const className = statement.name.text;
    const chains: Chain[] = [];
    for (const member of statement.members) {
      if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
        chains.push(...functionBodyChain(`B_${className}_${member.name.text}`, `${className}::${member.name.text}(${paramsText(member.parameters)})`, member.body));
      }
    }
    return chains;
  }
  return null;
}

export function mermaidForFile(relativePath: string, sourceText: string): string {
  const fileBoxId = "B_" + relativePath.replace(/[^A-Za-z0-9_]/g, "_");
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);

  const chains: Chain[] = [];
  const fileChainStatements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    const functionChains = functionLikeChains(statement);
    if (functionChains !== null) {
      chains.push(...functionChains);
      continue;
    }
    fileChainStatements.push(statement);
  }
  if (fileChainStatements.length > 0) {
    chains.push({ topBox: null, statements: fileChainStatements.map(statementRecord) });
  }

  const totalCounts = new Map<string, number>();
  for (const chain of chains) {
    for (const record of chain.statements) {
      totalCounts.set(record.baseId, (totalCounts.get(record.baseId) ?? 0) + 1);
    }
  }

  const runningCounts = new Map<string, number>();
  const boxLines: string[] = [];
  const edgeLines: string[] = [];
  for (const chain of chains) {
    const nodeIds: string[] = [];
    if (chain.topBox !== null) {
      boxLines.push(`${chain.topBox.id}["${chain.topBox.label}"]`);
      nodeIds.push(chain.topBox.id);
    }
    else {
      nodeIds.push(fileBoxId);
    }
    for (const record of chain.statements) {
      const total = totalCounts.get(record.baseId) ?? 0;
      const occurrence = (runningCounts.get(record.baseId) ?? 0) + 1;
      runningCounts.set(record.baseId, occurrence);
      const finalId = total > 1 ? `B_${record.baseId}${occurrence}` : `B_${record.baseId}`;
      boxLines.push(`${finalId}["${record.label}"]`);
      nodeIds.push(finalId);
    }
    edgeLines.push(nodeIds.join(" --> "));
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
