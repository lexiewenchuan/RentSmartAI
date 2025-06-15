import React from 'react';
import { StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';

export function MarkdownView({ content }: { content: string }) {
  return (
    <Markdown style={mdStyles}>
      {content || ''}
    </Markdown>
  );
}

const mdStyles = StyleSheet.create({
  body: { color: '#333', fontSize: 14, lineHeight: 22 },
  heading1: { fontSize: 20, fontWeight: '700', color: '#222', marginTop: 8, marginBottom: 8 },
  heading2: { fontSize: 18, fontWeight: '700', color: '#222', marginTop: 8, marginBottom: 6 },
  heading3: { fontSize: 16, fontWeight: '700', color: '#333', marginTop: 6, marginBottom: 4 },
  paragraph: { marginTop: 4, marginBottom: 8, lineHeight: 22 },
  bullet_list: { marginTop: 2, marginBottom: 6 },
  ordered_list: { marginTop: 2, marginBottom: 6 },
  list_item: { marginBottom: 4 },
  strong: { fontWeight: '700', color: '#1f2937' },
  em: { fontStyle: 'italic' },
  code_inline: { backgroundColor: '#f3f4f6', color: '#111827', paddingHorizontal: 4, borderRadius: 4 },
  code_block: { backgroundColor: '#111827', color: '#e5e7eb', padding: 10, borderRadius: 8 },
  fence: { backgroundColor: '#111827', color: '#e5e7eb', padding: 10, borderRadius: 8 },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#00ae66',
    paddingLeft: 10,
    color: '#4b5563',
    marginVertical: 8,
  },
});
