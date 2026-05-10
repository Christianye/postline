import type { Tool } from '@postline/core';

/**
 * A harmless echo tool for smoke-testing the turn loop.
 */
export function createEchoTool(): Tool {
  return {
    name: 'echo',
    description: 'Echo the input string back. Used for smoke tests.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      return { content: String(args.text ?? '') };
    },
  };
}
