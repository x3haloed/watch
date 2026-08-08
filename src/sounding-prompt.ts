import type { ModelMessage } from 'ai';
import type { ModelRegistry } from './model-registry.js';
import type { SkillLibrary } from './skills.js';
import type { Scratchpad } from './scratchpad.js';
import type { MemoryLattice } from './memory-lattice.js';
import { memoryContextFromSounding } from './memory-lattice.js';
import type { ResolvedModel, Sounding } from './types.js';
import type { RestModelBlockedNotice, RestModelNotice } from './lookout.js';
import { LOOKOUT_INSTRUCTIONS } from './lookout-instructions.js';
import {
  crossedContextThreshold,
  defaultUseFor,
  formatCapabilities,
  formatPercent,
  highestContextThresholdAtOrBelow,
  inferParamCount,
  prepareSoundingDeltas,
  validEstimatedTokenWarningThreshold,
  type SoundingMediaPart,
} from './lookout-helpers.js';
import type { ContextTokenTracker } from './token-estimator.js';
import type { SeedCrystalStore } from './seed-crystals.js';

export class SoundingPromptBuilder {
  private disclosedContextThreshold = 0;
  private disclosedEstimatedTokenWarning = false;

  constructor(
    private readonly input: {
      cwd: string;
      contextPrompt: Promise<string>;
      models: ModelRegistry;
      skills: SkillLibrary;
      listSubscriptions: () => string[];
      messages: ModelMessage[];
      restingModelId?: string;
      restAfterNoToolSoundings: number;
      estimatedTokenWarningThreshold: number;
      tokenTracker: ContextTokenTracker;
      scratchpad?: Scratchpad;
      memory?: MemoryLattice;
      seedCrystals?: SeedCrystalStore;
    },
  ) {}

  async instructions(): Promise<string> {
    const [context, modelRoster, availableSkills] = await Promise.all([
      this.input.contextPrompt,
      this.modelRosterPrompt(),
      this.availableSkillsPrompt(),
    ]);
    const environment = `[environment]\ncwd: ${this.input.cwd}\nFilesystem tools accept relative paths from cwd and absolute paths. They reject parent traversal paths containing "..".\n[/environment]`;
    return [LOOKOUT_INSTRUCTIONS, this.scratchpadGuidance(), environment, modelRoster, availableSkills, context, this.input.seedCrystals?.formatActiveBlock(), this.input.scratchpad?.agentPrompt()].filter(Boolean).join('\n\n');
  }

  formatSounding(input: {
    sounding: Sounding;
    model: ResolvedModel;
    restModelNotice?: RestModelNotice;
    restModelBlockedNotice?: RestModelBlockedNotice;
  }): { text: string; mediaParts: SoundingMediaPart[]; memoryCandidateIds: string[] } {
    const { sounding, model, restModelNotice, restModelBlockedNotice } = input;
    const preparedDeltas = prepareSoundingDeltas(sounding, model);
    const deltas = preparedDeltas.textLines.join('\n');
    const memoryResult = this.input.memory?.formatCandidateBlock(memoryContextFromSounding(sounding), 12);
    const memoryBlock = memoryResult?.block ?? '';
    const restModelFrame = restModelNotice ? `
[model_restored]
Watch has restored the resting model after ${restModelNotice.noToolSoundings} consecutive Soundings without tool calls.
from_model: ${restModelNotice.fromModelId}
to_model: ${restModelNotice.toModelId}
This is not a failure or loss of standing. It is the configured quiet substrate for continued presence.
You may continue monitoring, respond if needed, or reroute with handle_with_model if this Sounding requires another model.
[/model_restored]
` : '';
    const restModelBlockedFrame = restModelBlockedNotice ? `
[model_restore_blocked]
Watch tried to restore the configured resting model after ${restModelBlockedNotice.noToolSoundings} consecutive Soundings without tool calls, but did not switch models because the resting model's context window is too small for the current session.
from_model: ${restModelBlockedNotice.fromModelId}
attempted_to_model: ${restModelBlockedNotice.toModelId}
context: ${JSON.stringify(restModelBlockedNotice.context)}
This is a disclosure, not a punishment. You can continue on the current model, choose a larger model with handle_with_model, or call curl with a ledgerEntry to preserve what matters and clear session history before returning to the resting model.
[/model_restore_blocked]
` : '';

    const text = `[cff_system]
sounding_id: ${sounding.id}
last_flicker_ms: ${sounding.lastFlickerMs}
trigger: ${sounding.trigger}
clock: ${sounding.at}
active_model: ${model.id}
active_provider: ${model.provider}
active_provider_model: ${model.model}
active_model_capabilities: ${JSON.stringify(model.capabilities)}
available-models:
${this.input.models.listModelIds().map(id => `- ${id}`).join('\n')}
subscriptions:
${this.input.listSubscriptions().map(stream => `- ${stream}`).join('\n')}
[/cff_system]${this.estimatedTokenWarningFrame(model, sounding)}${this.contextDisclosureFrame(model, sounding)}
${memoryBlock ? `\n${memoryBlock}\n` : ''}

[deltas]
${deltas || '(none)'}
[/deltas]${restModelFrame}${restModelBlockedFrame}`;

    return { text, mediaParts: preparedDeltas.mediaParts, memoryCandidateIds: memoryResult?.candidates.map(candidate => candidate.id) ?? [] };
  }

  resetContextDisclosure(): void {
    this.disclosedContextThreshold = 0;
    this.disclosedEstimatedTokenWarning = false;
  }

  private scratchpadGuidance(): string {
    if (!this.input.scratchpad) {
      return '';
    }
    return [
      'A persistent scratchpad spans sessions. scratchpad_update_agent replaces AGENT.md with durable facts and orientation, such as user preferences from USER.md, environment details, tool quirks, and stable conventions.',
      'Notes that reduce future user steering are particularly useful. User preferences and recurring corrections generally retain value longer than procedural task details.',
      'AGENT.md is intended for durable orientation rather than task progress, session outcomes, completed-work logs, or temporary TODO state. The ledger holds testimony and session history; a fact likely to be stale within a week has little value in AGENT.md.',
      'Declarative scratchpad notes remain descriptive when re-read in later sessions. For example, "User prefers concise responses" describes a preference, whereas "Always respond concisely" can be interpreted as a directive.',
      'USER.md is user-owned. scratchpad_read returns both files; scratchpad_update_agent changes AGENT.md and has no USER.md write path.',
    ].join('\n');
  }

  private async modelRosterPrompt(): Promise<string> {
    const models = await this.input.models.resolveAll();
    const lines = models.map(model => {
      const capabilities = formatCapabilities(model.capabilities);
      const params = model.params ?? inferParamCount(`${model.id} ${model.model}`) ?? 'unknown';
      const role = model.role ?? (model.id === this.input.restingModelId ? 'resting/gazing' : 'available');
      const useFor = model.useFor ?? defaultUseFor(model, this.input.restingModelId);
      return [
        `- ${model.id}`,
        `  provider: ${model.provider}`,
        `  provider_model: ${model.model}`,
        `  role: ${role}`,
        `  params: ${params}`,
        `  capabilities: ${capabilities}`,
        `  use_for: ${useFor}`,
      ].join('\n');
    });

    return `[model_roster]
resting_model: ${this.input.restingModelId ?? '(none configured)'}
active_model_restore_policy: Watch may restore the resting model after ${this.input.restAfterNoToolSoundings} Soundings without tool calls. If the resting model cannot fit the current context, Watch will keep the current model and disclose the blocked restore with curl as an option.
reroute_guidance: handle_with_model is available when a Sounding calls for reasoning capacity, parameter scale, or modalities beyond the active model. Watch switches models within the same Sounding and continues inference after the tool result.
${lines.join('\n')}
[/model_roster]`;
  }

  private async availableSkillsPrompt(): Promise<string> {
    const skills = await this.input.skills.summaries();
    if (skills.length === 0) {
      return '';
    }

    const lines = skills.map(skill => {
      const category = skill.category ? ` category=${skill.category}` : '';
      const description = skill.description ? `: ${skill.description}` : '';
      return `- ${skill.name}${category} path=${skill.path}${description}`;
    });

    return `[available_skills]
These are SKILL.md frontmatter summaries discovered under cwd. skill_view returns a skill's full instructions and linked files.
${lines.join('\n')}
[/available_skills]`;
  }

  private contextDisclosureFrame(model: ResolvedModel, sounding: Sounding): string {
    const fit = this.input.tokenTracker.contextFitFor(model, this.input.tokenTracker.estimatePrompt({
      instructions: '',
      messages: this.input.messages,
      sounding,
    }));
    const crossed = crossedContextThreshold(fit.ratio, this.disclosedContextThreshold);
    if (fit.ratio !== null && fit.ratio < this.disclosedContextThreshold) {
      this.disclosedContextThreshold = highestContextThresholdAtOrBelow(fit.ratio);
    }
    if (!crossed) {
      return '';
    }

    this.disclosedContextThreshold = crossed;
    return `
[context_pressure]
current_context_ratio: ${formatPercent(fit.ratio)}
threshold_crossed: ${formatPercent(crossed)}
used_tokens_estimate: ${fit.usedTokensEstimate}
required_tokens_estimate: ${fit.requiredTokensEstimate}
active_model_limit_tokens: ${fit.limitTokens ?? 'unknown'}
${fit.recommendation ? `recommendation: ${fit.recommendation}` : 'recommendation: Context is growing. Keep curl available before the session becomes too heavy.'}
curl_available: curl accepts a ledgerEntry and clears the current session history after preserving it.
[/context_pressure]
`;
  }

  private estimatedTokenWarningFrame(model: ResolvedModel, sounding: Sounding): string {
    const threshold = validEstimatedTokenWarningThreshold(this.input.estimatedTokenWarningThreshold);
    if (threshold === undefined || this.disclosedEstimatedTokenWarning) {
      return '';
    }
    const fit = this.input.tokenTracker.contextFitFor(model, this.input.tokenTracker.estimatePrompt({
      instructions: '',
      messages: this.input.messages,
      sounding,
    }));
    if (fit.usedTokensEstimate < threshold) {
      return '';
    }

    this.disclosedEstimatedTokenWarning = true;
    return `
[estimated_token_warning]
Context window has passed ${threshold} estimated tokens.
used_tokens_estimate: ${fit.usedTokensEstimate}
Soundings will take longer to complete and timeout risk is increasing. Recommend \`curl\` when ready.
[/estimated_token_warning]
`;
  }
}
