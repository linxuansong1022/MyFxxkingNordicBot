## 5. 消息流转示例

假设用户输入"读取 README.md"，完整的消息流转：

```
messages = [
  { role: 'system', content: 'You are mini-code...' },
  { role: 'user', content: '读取 README.md' },
]

→ model.next(messages) 返回:
  { type: 'tool_calls', calls: [{ toolName: 'read_file', input: { path: 'README.md' } }] }

→ tools.execute('read_file', { path: 'README.md' }) 返回:
  { ok: true, output: 'FILE: README.md\n...' }

→ messages 变成:
  [...原来的, assistant_tool_call, tool_result]

→ model.next(messages) 返回:
  { type: 'assistant', content: '这是 README.md 的内容：...' }

→ 循环结束，显示给用户
```

---
