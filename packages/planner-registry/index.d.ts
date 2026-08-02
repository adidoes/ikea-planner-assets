export type PlannerSlug = string;
export type PlannerAdapter = "storage-one" | "method" | "space" | "enhet" | "skytta" | "sofas" | "worktop";

export interface PlannerDefinition<Slug extends string = string> {
  readonly slug: Slug;
  readonly aliases: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly family?: string;
  readonly cli: Readonly<{
    command: string;
    adapter: PlannerAdapter;
    exporter: string;
    profile?: string;
    defaultOutput: string;
    defaultName?: string;
  }>;
}

export const PLANNERS: readonly PlannerDefinition<PlannerSlug>[];
export const SPACE_PLANNERS: readonly PlannerDefinition<PlannerSlug>[];
export const SOFA_PLANNERS: readonly PlannerDefinition<PlannerSlug>[];
export const STORAGE_ONE_PLANNERS: readonly PlannerDefinition<PlannerSlug>[];
export const DEFAULT_PLANNER_SLUG: PlannerSlug;

export function normalizePlannerSlug(value: unknown): PlannerSlug | undefined;
export function getPlanner(value: unknown): PlannerDefinition<PlannerSlug> | undefined;
export function plannerChoiceMessage(): string;
