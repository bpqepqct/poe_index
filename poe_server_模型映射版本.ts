// deno run --allow-net --allow-read openai_proxy.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const UPSTREAM_API = "https://api.poe.com/v1/chat/completions";
let modelMapping: Record<string, string> = {};

// 加载模型映射
async function loadModelMapping() {
  try {
    const modelsText = await Deno.readTextFile("models.json");
    modelMapping = JSON.parse(modelsText);
    console.log(`已加载 ${Object.keys(modelMapping).length} 个模型映射`);
  } catch {
    console.warn("无法加载 models.json，将使用空映射");
  }
}

// 工具函数
const getToken = (req: Request) => req.headers.get("authorization")?.replace("Bearer ", "");
const mapModel = (model: string) => modelMapping[model] || model;
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 
    "content-type": "application/json",
    "access-control-allow-origin": "*" 
  }
});

// 过滤支持的参数
function filterRequestBody(body: any) {
  const supported = {
    model: mapModel(body.model),
    messages: body.messages,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    stream: body.stream,
    stream_options: body.stream_options,
    top_p: body.top_p,
    stop: body.stop,
    temperature: body.temperature ? Math.min(Math.max(body.temperature, 0), 2) : undefined,
    n: 1
  };
  
  return Object.fromEntries(Object.entries(supported).filter(([_, v]) => v !== undefined));
}

// 处理DALL-E-3图片生成
async function handleImageGeneration(req: Request) {
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  
  // 检查尺寸参数
  if (reqBody.size) {
    // 如果指定了尺寸但不是 1024x1024，返回错误
    if (reqBody.size !== "1024x1024") {
      console.log(`拒绝请求: 尺寸 ${reqBody.size} 不被支持`);
      return jsonResponse({ 
        error: { 
          message: `Invalid size: ${reqBody.size}. Only 1024x1024 is supported.`,
          type: "invalid_request_error",
          param: "size",
          code: "invalid_size"
        } 
      }, 400);
    }
  } else {
    // 如果没有指定尺寸，设置默认值为 1024x1024
    reqBody.size = "1024x1024";
    console.log("未指定尺寸，使用默认值: 1024x1024");
  }
  
  console.log(`处理图片生成请求: 尺寸=${reqBody.size}, prompt="${reqBody.prompt}"`);
  
  const chatRequest = filterRequestBody({
    model: "dall-e-3",
    messages: [{ role: "user", content: reqBody.prompt }],
    max_tokens: 1000
  });

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(chatRequest)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return jsonResponse({ 
        error: { 
          message: errorData.error?.message || "Upstream API error",
          type: getErrorType(response.status)
        } 
      }, response.status);
    }

    const chatResponse = await response.json();
    const content = chatResponse.choices?.[0]?.message?.content || "";
    const imageUrl = content.match(/https:\/\/[^\s\)]+/g)?.[0] || "";
    
    // 从AI响应中提取描述作为revised_prompt
    // 移除URL后的内容作为描述
    let revisedPrompt = content.replace(/https:\/\/[^\s\)]+/g, '').trim();
    
    // 如果没有描述内容，使用原始prompt
    if (!revisedPrompt || revisedPrompt.length < 10) {
      revisedPrompt = reqBody.prompt;
    }

    return jsonResponse({
      created: Math.floor(Date.now() / 1000),
      data: [{
        revised_prompt: revisedPrompt,
        url: imageUrl
      }]
    });

  } catch (error) {
    console.error("上游请求失败:", error);
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 处理聊天完成
async function handleChatCompletion(req: Request) {
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  const filteredBody = filterRequestBody(reqBody);

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(filteredBody)
    });

    const headers: Record<string, string> = {
      "access-control-allow-origin": "*"
    };

    if (filteredBody.stream) {
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      headers["connection"] = "keep-alive";
      return new Response(response.body, { status: response.status, headers });
    } else {
      headers["content-type"] = "application/json";
      const responseText = await response.text();
      return new Response(responseText, { status: response.status, headers });
    }

  } catch {
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 根据HTTP状态码映射错误类型
function getErrorType(status: number): string {
  const errorMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error", 
    402: "insufficient_credits",
    403: "moderation_error",
    404: "not_found_error",
    408: "timeout_error",
    413: "request_too_large",
    429: "rate_limit_error",
    502: "upstream_error",
    529: "overloaded_error"
  };
  return errorMap[status] || "unknown_error";
}

// 主处理函数
async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type"
      }
    });
  }

  if (req.method === "POST") {
    if (pathname === "/v1/images/generations") return handleImageGeneration(req);
    if (pathname === "/v1/chat/completions") return handleChatCompletion(req);
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const models = [...Object.keys(modelMapping), "dall-e-3"];
    return jsonResponse({
      object: "list",
      data: models.map(model => ({
        id: model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy"
      }))
    });
  }

  return jsonResponse({
    message: "OpenAI兼容代理服务",
    endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/models"]
  });
}

await loadModelMapping();
serve(handle, { port: 8000 });
console.log("🚀 服务已启动: http://localhost:8000");
