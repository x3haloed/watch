import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';

export function createSkillTools(ctx: LookoutToolContext) {
  return {
    skills_list: tool({
      description: 'List available SKILL.md skills with short metadata. Use skill_view to load full instructions.',
      inputSchema: jsonSchema<{ category?: string }>({
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter.' },
        },
        additionalProperties: false,
      }),
      execute: async ({ category }) => ctx.skills.list(category),
    }),
    skill_view: tool({
      description: 'Load a skill SKILL.md, or a linked file inside that skill directory.',
      inputSchema: jsonSchema<{ name: string; file_path?: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name, directory name, or skill path from skills_list.' },
          file_path: { type: 'string', description: 'Optional relative path inside the skill directory.' },
        },
        required: ['name'],
        additionalProperties: false,
      }),
      execute: async ({ name, file_path: filePath }) => ctx.skills.view(name, filePath),
    }),
  };
}
