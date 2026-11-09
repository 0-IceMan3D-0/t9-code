import { useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import {
  EMPTY_HISTORY,
  countLines,
  findMatches,
  findPattern,
  insertAt,
  lineColumn,
  lineOffset,
  nextMatchIndex,
  recordEdit,
  redo,
  replaceAll,
  undo,
  type EditorHistory,
  type EditorSelection,
} from "./explorerEditing";

const CODE_KEYS = [
  "⇥",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "<",
  ">",
  "=",
  ";",
  ":",
  '"',
  "'",
  "/",
  "\\",
  "|",
  "&",
  "-",
  "_",
  "$",
  "#",
  "`",
  "~",
];

function ToolButton(props: {
  readonly label: string;
  readonly icon?: Parameters<typeof SymbolView>[0]["name"];
  readonly text?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled), selected: Boolean(props.active) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-9 min-w-9 items-center justify-center rounded-[10px] px-2",
        props.active ? "bg-subtle-strong" : "active:bg-subtle",
        props.disabled && "opacity-40",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
      ) : (
        <Text maxFontSizeMultiplier={1.1} className="font-mono text-sm text-foreground">
          {props.text}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * A plain-text code editor: find and replace (literal, whole word or regex), undo and redo,
 * go to line, word wrap, text size and a row of symbol keys phone keyboards hide.
 */
export function ExplorerTextEditor(props: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly editable: boolean;
  readonly bottomInset: number;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [selection, setSelection] = useState<EditorSelection>({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelection] = useState<EditorSelection | null>(null);
  const [history, setHistory] = useState<EditorHistory>(EMPTY_HISTORY);
  const [fontSize, setFontSize] = useState(13);
  const [wrap, setWrap] = useState(true);
  const [find, setFind] = useState<{
    readonly query: string;
    readonly replacement: string;
    readonly caseSensitive: boolean;
    readonly regex: boolean;
    readonly wholeWord: boolean;
    readonly replacing: boolean;
  } | null>(null);
  const [current, setCurrent] = useState(-1);
  const pattern = find ? findPattern(find.query, find) : null;
  const matches = find ? findMatches(props.value, pattern) : [];
  const position = lineColumn(props.value, selection.start);
  const lines = countLines(props.value);

  const change = (text: string) => {
    setHistory((past) => recordEdit(past, props.value, text, Date.now()));
    props.onChange(text);
  };
  const select = (next: EditorSelection) => {
    setForcedSelection(next);
    setSelection(next);
    input.current?.focus();
  };
  const step = (backwards: boolean) => {
    const index = nextMatchIndex(matches, backwards ? selection.start : selection.end, backwards);
    if (index < 0) return;
    setCurrent(index);
    select(matches[index]!);
  };
  const insert = (key: string) => {
    const next = insertAt(props.value, selection, key === "⇥" ? "  " : key);
    change(next.text);
    select(next.selection);
  };
  const replaceCurrent = () => {
    if (!find || !pattern) return;
    const match = matches.find(
      (item) => item.start === selection.start && item.end === selection.end,
    );
    if (!match) return step(false);
    const replacement = find.regex
      ? props.value
          .slice(match.start, match.end)
          .replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), find.replacement)
      : find.replacement;
    const next = insertAt(props.value, match, replacement);
    change(next.text);
    select(next.selection);
  };
  const longestLine = wrap
    ? 0
    : Math.max(...props.value.split("\n", 5000).map((line) => line.length));

  const editor = (
    <TextInput
      ref={input}
      multiline
      value={props.value}
      onChangeText={change}
      editable={props.editable}
      onSelectionChange={(event) => {
        setSelection(event.nativeEvent.selection);
        if (forcedSelection) setForcedSelection(null);
      }}
      {...(forcedSelection ? { selection: forcedSelection } : {})}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      textAlignVertical="top"
      scrollEnabled={wrap}
      className="flex-1 px-3 pt-2 font-mono text-foreground"
      style={{
        fontSize,
        lineHeight: Math.round(fontSize * 1.45),
        paddingBottom: props.bottomInset + 24,
        ...(wrap ? {} : { minWidth: Math.max(longestLine * fontSize * 0.62 + 48, 360) }),
      }}
    />
  );

  return (
    <View className="flex-1">
      {find ? (
        <View className="gap-1 border-b border-border px-3 py-2">
          <View className="flex-row items-center gap-1">
            <TextInput
              autoFocus
              value={find.query}
              onChangeText={(query) => {
                setFind({ ...find, query });
                setCurrent(-1);
              }}
              onSubmitEditing={() => step(false)}
              placeholder="Find"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-9 flex-1 rounded-[10px] bg-subtle px-3 font-mono text-sm text-foreground"
            />
            <Text className="min-w-12 text-center text-xs text-foreground-muted">
              {find.query.length === 0
                ? ""
                : pattern === null
                  ? "Invalid"
                  : `${current >= 0 ? current + 1 : 0}/${matches.length}`}
            </Text>
            <ToolButton
              label="Previous match"
              icon="chevron.up"
              disabled={matches.length === 0}
              onPress={() => step(true)}
            />
            <ToolButton
              label="Next match"
              icon="chevron.down"
              disabled={matches.length === 0}
              onPress={() => step(false)}
            />
            <ToolButton label="Close find" icon="xmark" onPress={() => setFind(null)} />
          </View>
          <View className="flex-row items-center gap-1">
            <ToolButton
              label="Match case"
              text="Aa"
              active={find.caseSensitive}
              onPress={() => setFind({ ...find, caseSensitive: !find.caseSensitive })}
            />
            <ToolButton
              label="Whole word"
              text="W"
              active={find.wholeWord}
              onPress={() => setFind({ ...find, wholeWord: !find.wholeWord })}
            />
            <ToolButton
              label="Regular expression"
              text=".*"
              active={find.regex}
              onPress={() => setFind({ ...find, regex: !find.regex })}
            />
            {props.editable ? (
              <ToolButton
                label="Replace"
                text="Replace"
                active={find.replacing}
                onPress={() => setFind({ ...find, replacing: !find.replacing })}
              />
            ) : null}
          </View>
          {find.replacing && props.editable ? (
            <View className="flex-row items-center gap-1">
              <TextInput
                value={find.replacement}
                onChangeText={(replacement) => setFind({ ...find, replacement })}
                placeholder={find.regex ? "Replace ($1 for groups)" : "Replace"}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-9 flex-1 rounded-[10px] bg-subtle px-3 font-mono text-sm text-foreground"
              />
              <ToolButton
                label="Replace this match"
                text="One"
                disabled={matches.length === 0}
                onPress={replaceCurrent}
              />
              <ToolButton
                label="Replace all matches"
                text="All"
                disabled={matches.length === 0}
                onPress={() => {
                  const result = replaceAll(props.value, pattern, find.replacement, find.regex);
                  change(result.text);
                  Dialog.alert(
                    `Replaced ${result.count} ${result.count === 1 ? "match" : "matches"}`,
                  );
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {wrap ? (
        editor
      ) : (
        <ScrollView horizontal className="flex-1" contentContainerClassName="flex-grow">
          {editor}
        </ScrollView>
      )}
      <View className="border-t border-border">
        {props.editable ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1 px-2 py-1"
          >
            {CODE_KEYS.map((key) => (
              <ToolButton
                key={key}
                label={key === "⇥" ? "Indent" : `Insert ${key}`}
                text={key}
                onPress={() => insert(key)}
              />
            ))}
          </ScrollView>
        ) : null}
        <View
          className="flex-row items-center gap-1 px-2 pb-1"
          style={{ paddingBottom: props.bottomInset > 0 ? 4 : 4 }}
        >
          <ToolButton
            label="Find and replace"
            icon="magnifyingglass"
            active={find !== null}
            onPress={() =>
              setFind(
                find
                  ? null
                  : {
                      query: "",
                      replacement: "",
                      caseSensitive: false,
                      regex: false,
                      wholeWord: false,
                      replacing: false,
                    },
              )
            }
          />
          {props.editable ? (
            <>
              <ToolButton
                label="Undo"
                icon="arrow.uturn.backward"
                disabled={history.past.length === 0}
                onPress={() => {
                  const result = undo(history, props.value);
                  if (!result) return;
                  setHistory(result.history);
                  props.onChange(result.text);
                }}
              />
              <ToolButton
                label="Redo"
                icon="arrow.uturn.forward"
                disabled={history.future.length === 0}
                onPress={() => {
                  const result = redo(history, props.value);
                  if (!result) return;
                  setHistory(result.history);
                  props.onChange(result.text);
                }}
              />
            </>
          ) : null}
          <ToolButton
            label="Go to line"
            icon="list.number"
            onPress={() =>
              Dialog.prompt({
                title: "Go to line",
                message: `1 to ${lines}`,
                initialValue: String(position.line),
                confirmText: "Go",
                onConfirm: (value) => {
                  const line = Number.parseInt(value, 10);
                  if (!Number.isFinite(line)) return;
                  const offset = lineOffset(props.value, Math.min(Math.max(line, 1), lines));
                  select({ start: offset, end: offset });
                },
              })
            }
          />
          <ToolButton
            label={wrap ? "Turn off word wrap" : "Turn on word wrap"}
            icon="text.word.spacing"
            active={wrap}
            onPress={() => setWrap(!wrap)}
          />
          <ToolButton
            label="Smaller text"
            icon="textformat.size.smaller"
            disabled={fontSize <= 9}
            onPress={() => setFontSize(fontSize - 1)}
          />
          <ToolButton
            label="Larger text"
            icon="textformat.size.larger"
            disabled={fontSize >= 24}
            onPress={() => setFontSize(fontSize + 1)}
          />
          <Text
            maxFontSizeMultiplier={1.1}
            numberOfLines={1}
            className="ml-auto text-xs text-foreground-muted"
          >
            Ln {position.line}, Col {position.column} · {lines} lines
          </Text>
        </View>
      </View>
    </View>
  );
}
