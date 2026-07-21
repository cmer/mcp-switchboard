import type { ReactNode } from "react";
import {
  siAtlassian,
  siBrave,
  siCloudflare,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGooglechrome,
  siGoogledrive,
  siGooglesheets,
  siLinear,
  siNetlify,
  siNotion,
  siShadcnui,
  siShopify,
  siStripe,
  siSupabase,
  siVercel,
  siZapier,
  type SimpleIcon,
} from "simple-icons";
import playwrightLogo from "@/assets/playwright.svg";
import exaLogo from "@/assets/exa.png";

/* ---------- logos ---------- */

function Brand({ icon }: { icon: SimpleIcon }) {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}

// "aws" wordmark + smile, from simple-icons v9 (removed upstream later at Amazon's request)
const AWS_PATH =
  "M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z";

const awsLogo = (
  <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
    <path d={AWS_PATH} fill="#232F3E" />
  </svg>
);

const context7Logo = (
  <span
    aria-hidden
    className="flex size-6 items-center justify-center rounded-[6px] bg-[#10131a] font-mono text-[10px] font-bold tracking-tight text-white"
  >
    C7
  </span>
);

const firecrawlLogo = (
  <span aria-hidden className="flex size-6 items-center justify-center text-[18px] leading-none">
    🔥
  </span>
);

/* ---------- catalog ---------- */

export interface TemplateInput {
  key: string;
  label: string;
  hint?: string;
  required?: boolean;
  secret?: boolean;
  defaultValue?: string;
  /** Where the value lands in the create payload. */
  apply: "env" | "header" | "urlParam";
  /** Env var / header / query-param name. */
  name: string;
}

export interface ServerTemplate {
  slug: string;
  name: string;
  /** One-liner; also becomes the default agent-facing description. */
  tagline: string;
  logo: ReactNode;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  authType?: "oauth" | "none";
  inputs?: TemplateInput[];
  /** Extra setup context shown when the template is selected. */
  note?: string;
}

const GOOGLE_NOTE =
  "Runs workspace-mcp via uv. Needs a Google Cloud OAuth client (Desktop app) with the API enabled — console.cloud.google.com → APIs & Services → Credentials. Google sign-in completes in your browser on first use.";

const googleInputs: TemplateInput[] = [
  { key: "clientId", label: "Google OAuth client ID", required: true, apply: "env", name: "GOOGLE_OAUTH_CLIENT_ID" },
  {
    key: "clientSecret",
    label: "Google OAuth client secret",
    required: true,
    secret: true,
    apply: "env",
    name: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
];

function googleWorkspace(
  slug: string,
  name: string,
  tagline: string,
  tool: string,
  icon: SimpleIcon,
): ServerTemplate {
  return {
    slug,
    name,
    tagline,
    logo: <Brand icon={icon} />,
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp", "--tools", tool],
    inputs: googleInputs,
    note: GOOGLE_NOTE,
  };
}

const TEMPLATES: ServerTemplate[] = [
  {
    slug: "github",
    name: "GitHub",
    tagline: "Repos, issues, pull requests",
    logo: <Brand icon={siGithub} />,
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authType: "oauth",
  },
  {
    slug: "linear",
    name: "Linear",
    tagline: "Issues, projects, cycles",
    logo: <Brand icon={siLinear} />,
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authType: "oauth",
  },
  {
    slug: "atlassian",
    name: "Jira & Confluence",
    tagline: "Atlassian issues and wiki",
    logo: <Brand icon={siAtlassian} />,
    transport: "sse",
    url: "https://mcp.atlassian.com/v1/sse",
    authType: "oauth",
  },
  {
    slug: "notion",
    name: "Notion",
    tagline: "Pages and databases",
    logo: <Brand icon={siNotion} />,
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    authType: "oauth",
  },
  {
    slug: "stripe",
    name: "Stripe",
    tagline: "Payments data and docs",
    logo: <Brand icon={siStripe} />,
    transport: "http",
    url: "https://mcp.stripe.com",
    authType: "oauth",
  },
  {
    slug: "shopify",
    name: "Shopify",
    tagline: "Shopify dev docs & GraphQL schemas",
    logo: <Brand icon={siShopify} />,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@shopify/dev-mcp@latest"],
  },
  {
    slug: "vercel",
    name: "Vercel",
    tagline: "Projects and deployments",
    logo: <Brand icon={siVercel} />,
    transport: "http",
    url: "https://mcp.vercel.com",
    authType: "oauth",
  },
  {
    slug: "netlify",
    name: "Netlify",
    tagline: "Sites and deploys",
    logo: <Brand icon={siNetlify} />,
    transport: "http",
    url: "https://netlify-mcp.netlify.app/mcp",
    authType: "oauth",
  },
  {
    slug: "cloudflare",
    name: "Cloudflare",
    tagline: "Workers, KV, R2, D1",
    logo: <Brand icon={siCloudflare} />,
    transport: "sse",
    url: "https://bindings.mcp.cloudflare.com/sse",
    authType: "oauth",
  },
  {
    slug: "supabase",
    name: "Supabase",
    tagline: "Postgres, auth, storage",
    logo: <Brand icon={siSupabase} />,
    transport: "http",
    url: "https://mcp.supabase.com/mcp",
    authType: "oauth",
  },
  {
    slug: "context7",
    name: "Context7",
    tagline: "Up-to-date library docs",
    logo: context7Logo,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    authType: "none",
    inputs: [
      {
        key: "apiKey",
        label: "API key",
        hint: "optional — higher rate limits & private repos, from context7.com/dashboard",
        secret: true,
        apply: "header",
        name: "CONTEXT7_API_KEY",
      },
    ],
  },
  {
    slug: "shadcn",
    name: "shadcn/ui",
    tagline: "Component registry, add & search",
    logo: <Brand icon={siShadcnui} />,
    transport: "stdio",
    command: "npx",
    args: ["shadcn@latest", "mcp"],
  },
  {
    slug: "firecrawl",
    name: "Firecrawl",
    tagline: "Scrape & crawl the web",
    logo: firecrawlLogo,
    transport: "stdio",
    command: "npx",
    args: ["-y", "firecrawl-mcp"],
    inputs: [
      {
        key: "apiKey",
        label: "API key",
        hint: "from firecrawl.dev",
        required: true,
        secret: true,
        apply: "env",
        name: "FIRECRAWL_API_KEY",
      },
    ],
  },
  {
    slug: "exa",
    name: "Exa",
    tagline: "AI web search",
    logo: <img src={exaLogo} alt="" className="size-6 rounded-[5px]" />,
    transport: "http",
    url: "https://mcp.exa.ai/mcp",
    authType: "none",
    inputs: [
      {
        key: "apiKey",
        label: "API key",
        hint: "from dashboard.exa.ai",
        required: true,
        secret: true,
        apply: "urlParam",
        name: "exaApiKey",
      },
    ],
  },
  {
    slug: "brave-search",
    name: "Brave Search",
    tagline: "Web search API",
    logo: <Brand icon={siBrave} />,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@brave/brave-search-mcp-server"],
    inputs: [
      {
        key: "apiKey",
        label: "API key",
        hint: "from brave.com/search/api",
        required: true,
        secret: true,
        apply: "env",
        name: "BRAVE_API_KEY",
      },
    ],
  },
  {
    slug: "playwright",
    name: "Playwright",
    tagline: "Drive a real browser",
    logo: <img src={playwrightLogo} alt="" className="size-6" />,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
  },
  {
    slug: "chrome-devtools",
    name: "Chrome DevTools",
    tagline: "Console, network, traces",
    logo: <Brand icon={siGooglechrome} />,
    transport: "stdio",
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@latest"],
  },
  {
    slug: "aws",
    name: "AWS",
    tagline: "Call AWS APIs",
    logo: awsLogo,
    transport: "stdio",
    command: "uvx",
    args: ["awslabs.aws-api-mcp-server@latest"],
    note: "Uses the AWS credentials already configured on this machine (~/.aws). Requires uv.",
    inputs: [
      {
        key: "region",
        label: "Region",
        defaultValue: "us-east-1",
        required: true,
        apply: "env",
        name: "AWS_REGION",
      },
    ],
  },
  {
    slug: "zapier",
    name: "Zapier",
    tagline: "8,000+ apps via Zapier actions",
    logo: <Brand icon={siZapier} />,
    transport: "http",
    url: "https://mcp.zapier.com/api/v1/connect",
    authType: "oauth",
  },
  googleWorkspace("gmail", "Gmail", "Search, read & draft email", "gmail", siGmail),
  googleWorkspace("google-drive", "Google Drive", "Files and folders", "drive", siGoogledrive),
  googleWorkspace("google-calendar", "Google Calendar", "Events and scheduling", "calendar", siGooglecalendar),
  googleWorkspace("google-sheets", "Google Sheets", "Read & write spreadsheets", "sheets", siGooglesheets),
];

export const SERVER_TEMPLATES: ServerTemplate[] = [...TEMPLATES].sort((a, b) => a.name.localeCompare(b.name));

/* ---------- payload builder ---------- */

export function templatePayload(
  t: ServerTemplate,
  slug: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const base = { name: t.name, slug, description: t.tagline };
  if (t.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const inp of t.inputs ?? []) {
      const v = values[inp.key]?.trim();
      if (v && inp.apply === "env") env[inp.name] = v;
    }
    return {
      ...base,
      type: "stdio",
      command: t.command,
      args: t.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  let url = t.url!;
  const headers: Record<string, string> = {};
  for (const inp of t.inputs ?? []) {
    const v = values[inp.key]?.trim();
    if (!v) continue;
    if (inp.apply === "header") headers[inp.name] = v;
    else if (inp.apply === "urlParam") url += `${url.includes("?") ? "&" : "?"}${inp.name}=${encodeURIComponent(v)}`;
  }
  const authType = t.authType === "oauth" ? "oauth" : Object.keys(headers).length > 0 ? "headers" : "none";
  return {
    ...base,
    type: t.transport,
    url,
    authType,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function templateReady(t: ServerTemplate, values: Record<string, string>): boolean {
  return (t.inputs ?? []).every((inp) => !inp.required || !!values[inp.key]?.trim());
}
