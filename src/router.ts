import { loadProbe } from "./store.js";
import type {
  AutoProbeResult,
  ModelProfile,
  ModelProfilesConfig,
  RouteDecision,
  TaskComplexity,
  TaskRole,
  WorkflowConfig,
} from "./types.js";

const complexityRank: Record<TaskComplexity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function detectRole(goal: string): TaskRole {
  const normalized = goal.toLowerCase();

  if (/(review|audit|check|inspect)/.test(normalized)) {
    return "reviewer";
  }

  if (/(debug|fix|bug|incident|failure|error)/.test(normalized)) {
    return "debugger";
  }

  if (/(plan|roadmap|proposal|spec|outline)/.test(normalized)) {
    return "planner";
  }

  if (/(architecture|design system|refactor|cross-module|migration)/.test(normalized)) {
    return "architect";
  }

  if (/(copy|content|ux|wording|landing|chinese|文案|产品)/.test(normalized)) {
    return "copywriter";
  }

  return "implementer";
}

function detectComplexity(goal: string): TaskComplexity {
  const normalized = goal.toLowerCase();

  if (
    normalized.length > 140 ||
    /(architecture|cross-module|migration|system|multi-step|refactor|platform)/.test(normalized)
  ) {
    return "high";
  }

  if (
    normalized.length > 70 ||
    /(review|debug|plan|integrate|endpoint|workflow|route)/.test(normalized)
  ) {
    return "medium";
  }

  return "low";
}

function supportsComplexity(profile: ModelProfile, complexity: TaskComplexity): boolean {
  return complexityRank[profile.maxComplexity] >= complexityRank[complexity];
}

function computeFallbackExecutors(
  selectedProfileName: string,
  selectedProfile: ModelProfile,
  role: TaskRole,
  complexity: TaskComplexity,
  profiles: Record<string, ModelProfile>,
  availableExecutors: Set<string>,
): string[] {
  const explicit = (selectedProfile.fallbackExecutors ?? [])
    .filter((executor) => availableExecutors.has(executor));

  const implicit = Object.entries(profiles)
    .filter(([name, profile]) => name !== selectedProfileName)
    .filter(([, profile]) => availableExecutors.has(profile.executor))
    .filter(([, profile]) => supportsComplexity(profile, complexity))
    .filter(([, profile]) => profile.costRank > selectedProfile.costRank)
    .sort((a, b) => a[1].costRank - b[1].costRank)
    .sort((a, b) => {
      const aRole = a[1].preferredRoles.includes(role) ? 1 : 0;
      const bRole = b[1].preferredRoles.includes(role) ? 1 : 0;
      return bRole - aRole;
    })
    .map(([, profile]) => profile.executor);

  return [...new Set([...explicit, ...implicit])];
}

export async function availableExecutorsFromProbes(
  rootDir: string,
  config: WorkflowConfig,
): Promise<Set<string>> {
  const entries = await Promise.all(
    Object.keys(config.executors).map(async (executorName) => {
      try {
        const probe = await loadProbe(rootDir, executorName);
        const failed = probe.attempts.every((attempt) => attempt.workerResult.status !== "ok");
        return failed ? null : executorName;
      } catch {
        return executorName;
      }
    }),
  );

  return new Set(entries.filter((value): value is string => Boolean(value)));
}

export async function routeGoals(
  rootDir: string,
  goals: string[],
  config: WorkflowConfig,
  profilesConfig: ModelProfilesConfig,
): Promise<RouteDecision[]> {
  const availableExecutors = await availableExecutorsFromProbes(rootDir, config);

  return goals.map((goal) => {
    const role = detectRole(goal);
    const complexity = detectComplexity(goal);
    const candidates = Object.entries(profilesConfig.modelProfiles)
      .filter(([, profile]) => config.executors[profile.executor])
      .filter(([, profile]) => availableExecutors.has(profile.executor))
      .filter(([, profile]) => supportsComplexity(profile, complexity))
      .sort((a, b) => a[1].costRank - b[1].costRank)
      .sort((a, b) => {
        const aRole = a[1].preferredRoles.includes(role) ? 1 : 0;
        const bRole = b[1].preferredRoles.includes(role) ? 1 : 0;
        return bRole - aRole;
      });

    if (candidates.length === 0) {
      throw new Error(`No available executor can route goal: ${goal}`);
    }

    const [profileName, profile] = candidates[0];
    const fallbackExecutors = computeFallbackExecutors(
      profileName,
      profile,
      role,
      complexity,
      profilesConfig.modelProfiles,
      availableExecutors,
    );

    return {
      goal,
      profile: profileName,
      executor: profile.executor,
      fallbackExecutors,
      role,
      complexity,
      reason: [
        `role=${role}`,
        `complexity=${complexity}`,
        `costRank=${profile.costRank}`,
        `preferredRoles=${profile.preferredRoles.join("/")}`,
      ].join(", "),
      attemptedExecutors: [profile.executor],
    };
  });
}

export function summarizeRouteMix(routes: RouteDecision[]): string {
  const counts = routes.reduce<Record<string, number>>((acc, route) => {
    acc[route.profile] = (acc[route.profile] ?? 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .map(([profile, count]) => `${profile}:${count}`)
    .join(", ");
}
