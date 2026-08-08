import { jsonSchema, tool } from 'ai';
import { mediaToolOutputToModelOutput } from '../lookout-helpers.js';
import type { LookoutToolContext } from './context.js';

export function createFileTools(ctx: LookoutToolContext) {
  return {
    read_file: tool({
      description: 'Read a UTF-8 text file with line numbers and pagination. A media path returns an open_media hint instead. Relative paths resolve from cwd and absolute paths are accepted; paths containing .. are rejected.',
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to read. Relative paths resolve from cwd; absolute paths are accepted.' },
          offset: { type: 'number', description: '1-based starting line. Defaults to 1.' },
          limit: { type: 'number', description: 'Maximum lines to return. Defaults to 500, max 1000.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, offset, limit }) => ctx.files.readFile(path, offset, limit),
    }),
    open_media: tool({
      description:
        'Attach an image, audio file, video, or PDF to the model. path identifies filesystem media; inboxMessageId plus attachmentId identifies a Discord attachment. A modality mismatch result includes recommended handle_with_model targets.',
      inputSchema: jsonSchema<{ path?: string; inboxMessageId?: number; attachmentId?: string; url?: string; mediaType?: string; filename?: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Filesystem path to media. Relative paths resolve from cwd; absolute paths are accepted.' },
          inboxMessageId: { type: 'number', description: 'Discord inbox message ID containing the attachment.' },
          attachmentId: { type: 'string', description: 'Discord attachment ID from open_message or discord_read_context.' },
          url: { type: 'string', description: 'Direct media URL. Discord attachments can also be identified by inboxMessageId and attachmentId.' },
          mediaType: { type: 'string', description: 'IANA media type for URL media when known.' },
          filename: { type: 'string', description: 'Filename for URL media when known.' },
        },
        additionalProperties: false,
      }),
      execute: async input => ctx.openMediaForModel(input, ctx.currentModel()),
      toModelOutput: (options: { output: unknown }) => mediaToolOutputToModelOutput(options.output) as never,
    }),
    write_file: tool({
      description:
        'Create a UTF-8 text file. Relative paths resolve from cwd and absolute paths are accepted; paths containing .. are rejected. Existing files are rejected unless overwrite=true. patch supports exact-string changes to an existing file.',
      inputSchema: jsonSchema<{ path: string; content: string; overwrite?: boolean }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write. Relative paths resolve from cwd; absolute paths are accepted.' },
          content: { type: 'string', description: 'Complete file content to write.' },
          overwrite: {
            type: 'boolean',
            description:
              'Defaults to false. Replacing an existing file succeeds when this is true. patch is available for exact-string changes.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
      execute: async ({ path, content, overwrite }) => ctx.files.writeFile(path, content, overwrite),
    }),
    search_files: tool({
      description: 'Search files by content using ripgrep, or list file paths containing a substring. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.',
      inputSchema: jsonSchema<{
        pattern: string;
        target?: 'content' | 'files';
        path?: string;
        fileGlob?: string;
        limit?: number;
      }>({
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern for content search, or substring for file search.' },
          target: { type: 'string', enum: ['content', 'files'], description: 'Search content or file paths. Defaults to content.' },
          path: { type: 'string', description: 'Directory or file to search. Defaults to cwd. Relative paths resolve from cwd; absolute paths are accepted.' },
          fileGlob: { type: 'string', description: 'Optional ripgrep glob, for example *.ts.' },
          limit: { type: 'number', description: 'Maximum matches. Defaults to 50, max 200.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      }),
      execute: async input => ctx.files.searchFiles(input),
    }),
    patch: tool({
      description: 'Replace an exact string in a file. Relative paths resolve from cwd and absolute paths are accepted; paths containing .. are rejected. A patch succeeds when old_string matches the file content.',
      inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to patch. Relative paths resolve from cwd; absolute paths are accepted.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      }),
      execute: async ({ path, old_string: oldString, new_string: newString, replace_all: replaceAll }) =>
        ctx.files.patch(path, oldString, newString, replaceAll),
    }),
  };
}
