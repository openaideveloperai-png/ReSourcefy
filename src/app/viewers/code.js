// Code editor (CodeMirror 6) with languages for every engine's scripts.
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, StreamLanguage } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { xml } from '@codemirror/lang-xml';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { wast } from '@codemirror/legacy-modes/mode/wast';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { go } from '@codemirror/legacy-modes/mode/go';

// GDScript (Godot) tokenizer
const GD_KW = new Set('if elif else for while match break continue pass return class class_name extends is in as self signal func static const enum var onready export setget tool breakpoint preload await yield assert void and or not super when'.split(' '));
const GD_ATOM = new Set('true false null PI TAU INF NAN'.split(' '));
const gdscript = {
  name: 'gdscript',
  startState: () => ({ inString: null }),
  token(stream, state) {
    if (state.inString) {
      const q = state.inString;
      while (!stream.eol()) {
        if (stream.match(q)) { state.inString = null; return 'string'; }
        if (stream.next() === '\\') stream.next();
      }
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('#')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('"""') || stream.match("'''")) { state.inString = stream.current(); return 'string'; }
    if (stream.match(/^&?"(?:[^"\\]|\\.)*"?/) || stream.match(/^&?'(?:[^'\\]|\\.)*'?/) || stream.match(/^\^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^\$[\w/%.]+/) || stream.match(/^%[\w]+/)) return 'variableName.special';
    if (stream.match(/^@\w+/)) return 'meta';
    if (stream.match(/^0x[\da-fA-F_]+|^0b[01_]+|^\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (GD_KW.has(w)) return 'keyword';
      if (GD_ATOM.has(w)) return 'atom';
      if (/^[A-Z]/.test(w)) return 'typeName';
      if (stream.peek() === '(') return 'variableName.function';
      return 'variableName';
    }
    if (stream.match(/^(->|:=|[+\-*/%=<>!&|^~]=?)/)) return 'operator';
    stream.next();
    return null;
  },
};

// IL (CIL disassembly) tokenizer
const il = {
  name: 'il',
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^IL_[0-9a-fA-F]+:?/)) return 'labelName';
    if (stream.match(/^\.[a-z]+/)) return 'keyword';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^(0x[\da-fA-F]+|-?\d+(\.\d+)?)/)) return 'number';
    if (stream.match(/^(ldarg|ldloc|stloc|starg|ldc|ldstr|ldfld|stfld|ldsfld|stsfld|call|callvirt|newobj|ret|br|brtrue|brfalse|beq|bne|bgt|bge|blt|ble|switch|ldnull|box|unbox|castclass|isinst|throw|leave|endfinally|dup|pop|ldelem|stelem|ldlen|newarr|conv|add|sub|mul|div|rem|and|or|xor|shl|shr|neg|not|ceq|cgt|clt|ldftn|ldvirtftn|ldtoken|initobj|ldind|stind|ldflda|ldsflda|ldloca|ldarga|sizeof|constrained|volatile|tail|readonly|nop|localloc|cpblk|initblk|ldobj|stobj|cpobj|mkrefany|refanyval|refanytype|ckfinite|arglist|jmp|calli|rethrow|endfilter|ldelema)[.\w]*/)) return 'keyword';
    if (stream.match(/^[A-Za-z_][\w`.<>]*/)) return 'variableName';
    stream.next();
    return null;
  },
};

const LANGS = {
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  json: () => json(),
  html: () => html(),
  css: () => css(),
  xml: () => xml(),
  python: () => python(),
  renpy: () => python(),
  cpp: () => cpp(),
  c: () => cpp(),
  shader: () => cpp(),
  java: () => java(),
  kotlin: () => StreamLanguage.define(kotlin),
  markdown: () => markdown(),
  yaml: () => yaml(),
  csharp: () => StreamLanguage.define(csharp),
  lua: () => StreamLanguage.define(lua),
  ruby: () => StreamLanguage.define(ruby),
  shell: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  ini: () => StreamLanguage.define(properties),
  wat: () => StreamLanguage.define(wast),
  sql: () => StreamLanguage.define(standardSQL),
  rust: () => StreamLanguage.define(rust),
  go: () => StreamLanguage.define(go),
  gdscript: () => StreamLanguage.define(gdscript),
  il: () => StreamLanguage.define(il),
  gml: () => javascript(),
  actionscript: () => javascript(),
};

export const LANG_LABELS = {
  javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', html: 'HTML', css: 'CSS', xml: 'XML', python: 'Python', renpy: "Ren'Py",
  cpp: 'C/C++', shader: 'Shader', java: 'Java', markdown: 'Markdown', yaml: 'YAML', csharp: 'C#', lua: 'Lua', ruby: 'Ruby',
  shell: 'Shell', toml: 'TOML', ini: 'INI', wat: 'WebAssembly', sql: 'SQL', rust: 'Rust', go: 'Go', gdscript: 'GDScript', il: 'CIL', gml: 'GML', text: 'Plain text',
};

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--syn-func)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.special(t.variableName)], color: 'var(--syn-meta)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-punct)' },
  { tag: t.heading, color: 'var(--syn-type)', fontWeight: '600' },
  { tag: t.invalid, color: 'var(--err)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--faint)', borderRight: '1px solid var(--line-soft)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel) !important' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warm) 30%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderColor: 'var(--line)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', border: '1px solid var(--line)', color: 'var(--muted)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', border: '1px solid var(--line)' },
});

export function createEditor(parent, { text = '', lang = 'text', readOnly = false, onChange, onSave } = {}) {
  const langComp = new Compartment();
  const roComp = new Compartment();
  const langExt = LANGS[lang] ? LANGS[lang]() : [];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
        indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([
          { key: 'Mod-s', run: () => { onSave && onSave(); return true; }, preventDefault: true },
          ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
        ]),
        syntaxHighlighting(highlight), theme,
        langComp.of(langExt),
        roComp.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(u); }),
      ],
    }),
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(s) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s } }); },
    setLang(l) { view.dispatch({ effects: langComp.reconfigure(LANGS[l] ? LANGS[l]() : []) }); },
    setReadOnly(r) { view.dispatch({ effects: roComp.reconfigure(EditorState.readOnly.of(r)) }); },
    gotoLine(line, col = 0, len = 0) {
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      const from = Math.min(l.from + col, l.to);
      view.dispatch({ selection: { anchor: from, head: Math.min(from + len, l.to) }, scrollIntoView: true });
      view.focus();
    },
    destroy() { view.destroy(); },
  };
}

export async function formatCode(text, lang) {
  const mod = await import('js-beautify/js/lib/beautifier.js');
  const b = mod.default || mod;
  const opts = { indent_size: 2, max_preserve_newlines: 2, space_in_empty_paren: false, wrap_line_length: 0 };
  if (lang === 'css') return b.css(text, opts);
  if (lang === 'html' || lang === 'xml') return b.html(text, opts);
  if (lang === 'json') {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return b.js(text, opts); }
  }
  return b.js(text, opts);
}
