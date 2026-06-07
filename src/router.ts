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

function routePreferenceScore(
  profile: ModelProfile,
  role: TaskRole,
  complexity: TaskComplexity,
): number {
  let score = 0;

  if (profile.preferredRoles.includes(role)) {
    score += 20;
  }

  if (profile.executor === "opencode") {
    if (role === "implementer" && complexity === "low") {
      score += 10;
    }

    if (role === "planner" || role === "reviewer" || role === "copywriter" || role === "architect") {
      score -= 30;
    }

    if (complexity !== "low") {
      score -= 15;
    }
  }

  if (profile.executor === "opencode-pro") {
    if (role === "architect" || role === "reviewer") {
      score += 25;
    }

    if (role === "debugger" && complexity !== "low") {
      score += 15;
    }

    if (complexity === "high") {
      score += 15;
    }
  }

  if (profile.executor === "mimo" || profile.executor === "mimo-free") {
    if (role === "planner" || role === "copywriter") {
      score += 25;
    }

    if (profile.executor === "mimo-free") {
      score += 5;
    }

    if (complexity === "high") {
      score -= 10;
    }
  }

  return score;
}

function computeFallbackExecutors(
  selectedProfileName: string,
  selectedProfile: ModelProfile,
  role: TaskRole,
  complexity: TaskComplexity,
  profiles: Record<string, ModelProfile>,
  availableExecutors: Set<string>,
): string[] {
  const preferredFallbackOrder = role === "implementer" && complexity === "low"
    ? ["opencode-serve", "mimo-free", "mimo", "opencode-pro"]
    : [];

  const explicit = (selectedProfile.fallbackExecutors ?? [])
    .filter((executor) => availableExecutors.has(executor));

  const implicit = Object.entries(profiles)
    .filter(([name, profile]) => name !== selectedProfileName)
    .filter(([, profile]) => availableExecutors.has(profile.executor))
    .filter(([, profile]) => supportsComplexity(profile, complexity))
    .filter(([, profile]) => {
      if (profile.costRank > selectedProfile.costRank) {
        return true;
      }

      return preferredFallbackOrder.includes(profile.executor);
    })
    .sort((a, b) => {
      const aPreferred = preferredFallbackOrder.includes(a[1].executor);
      const bPreferred = preferredFallbackOrder.includes(b[1].executor);
      if (aPreferred && !bPreferred) {
        return -1;
      }
      if (!aPreferred && bPreferred) {
        return 1;
      }
      if (aPreferred && bPreferred) {
        return preferredFallbackOrder.indexOf(a[1].executor) - preferredFallbackOrder.indexOf(b[1].executor);
      }

      const delta = routePreferenceScore(b[1], role, complexity) - routePreferenceScore(a[1], role, complexity);
      if (delta !== 0) {
        return delta;
      }
      return a[1].costRank - b[1].costRank;
    })
    .map(([, profile]) => profile.executor);

  const combined = [...new Set([...explicit, ...implicit])];
  return combined.sort((a, b) => {
    const aPreferred = preferredFallbackOrder.includes(a);
    const bPreferred = preferredFallbackOrder.includes(b);
    if (aPreferred && !bPreferred) {
      return -1;
    }
    if (!aPreferred && bPreferred) {
      return 1;
    }
    if (aPreferred && bPreferred) {
      return preferredFallbackOrder.indexOf(a) - preferredFallbackOrder.indexOf(b);
    }
    return 0;
  });
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
    if (/ - produce a short implementation plan$/i.test(goal) && availableExecutors.has("opencode-pro")) {
      return {
        goal,
        profile: "deepwork/planner-structured",
        executor: "opencode-pro",
        fallbackExecutors: availableExecutors.has("mimo-free")
          ? ["mimo-free"]
          : availableExecutors.has("mimo")
            ? ["mimo"]
            : [],
        role: "planner",
        complexity,
        reason: "role=planner, structured deepwork planner prefers opencode-pro for schema reliability",
        attemptedExecutors: ["opencode-pro"],
      };
    }

    const candidates = Object.entries(profilesConfig.modelProfiles)
      .filter(([, profile]) => config.executors[profile.executor])
      .filter(([, profile]) => availableExecutors.has(profile.executor))
      .filter(([, profile]) => supportsComplexity(profile, complexity))
      .sort((a, b) => {
        const delta = routePreferenceScore(b[1], role, complexity) - routePreferenceScore(a[1], role, complexity);
        if (delta !== 0) {
          return delta;
        }
        return a[1].costRank - b[1].costRank;
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
        `preferenceScore=${routePreferenceScore(profile, role, complexity)}`,
        `costRank=${profile.costRank}`,
        `preferredRoles=${profile.preferredRoles.join("/")}`,
      ].join(", "),
      attemptedExecutors: [profile.executor],
    };
  });
}

export function preferExplicitExecutor(
  route: RouteDecision,
  executor: string,
): RouteDecision {
  if (route.executor === executor) {
    return route;
  }

  const fallbackExecutors = [route.executor, ...route.fallbackExecutors]
    .filter((candidate, index, values) => candidate !== executor && values.indexOf(candidate) === index);

  return {
    ...route,
    executor,
    fallbackExecutors,
    attemptedExecutors: [executor],
    reason: `${route.reason}, explicitExecutor=${executor}`,
  };
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
