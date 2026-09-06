type MarkdownNode = {
  type: string;
  value?: string;
  data?: { hName?: string };
  children?: MarkdownNode[];
};

const EXTENDED_MARKS = [
  { delimiter: '++', type: 'underline', tagName: 'u' },
  { delimiter: '==', type: 'highlight', tagName: 'mark' },
] as const;

function firstCompleteMark(value: string) {
  let match: { start: number; end: number; delimiter: string; type: string; tagName: string } | null = null;
  for (const mark of EXTENDED_MARKS) {
    let start = value.indexOf(mark.delimiter);
    while (start >= 0) {
      const next = value[start + mark.delimiter.length];
      const opensNestedMark = EXTENDED_MARKS.some((nested) => value.startsWith(nested.delimiter, start + mark.delimiter.length));
      // A marker must open onto content. This keeps ordinary text such as
      // `C++，` intact while still allowing `文字++下划线++`.
      if (next && (opensNestedMark || !/[\s\p{P}\p{S}]/u.test(next))) {
        let end = value.indexOf(mark.delimiter, start + mark.delimiter.length);
        while (end >= 0 && /\s/u.test(value[end - 1] || '')) {
          end = value.indexOf(mark.delimiter, end + mark.delimiter.length);
        }
        if (end >= 0 && (!match || start < match.start || (start === match.start && end > match.end))) {
          match = { start, end, ...mark };
        }
        break;
      }
      start = value.indexOf(mark.delimiter, start + mark.delimiter.length);
    }
  }
  return match;
}

/** Parse the portable `++underline++` and `==highlight==` syntax emitted by TipTap. */
function extendedMarkNodes(value: string): MarkdownNode[] {
  const match = firstCompleteMark(value);
  if (!match) return value ? [{ type: 'text', value }] : [];

  const before = value.slice(0, match.start);
  const content = value.slice(match.start + match.delimiter.length, match.end);
  const after = value.slice(match.end + match.delimiter.length);
  if (!content) return [{ type: 'text', value }];

  return [
    ...extendedMarkNodes(before),
    {
      type: match.type,
      data: { hName: match.tagName },
      children: extendedMarkNodes(content),
    },
    ...extendedMarkNodes(after),
  ];
}

function transformChildren(node: MarkdownNode) {
  if (!node.children || node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return extendedMarkNodes(child.value);
    transformChildren(child);
    return child;
  });
}

/** React Markdown plugin keeping readonly cards faithful to the rich-text editor. */
export function remarkExtendedMarks() {
  return (tree: MarkdownNode) => transformChildren(tree);
}
