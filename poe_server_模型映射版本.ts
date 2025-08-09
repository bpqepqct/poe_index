// deno run --allow-net --allow-read openai_proxy.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 适配你要转发到的实际 LLM 接口（可自定义）
const UPSTREAM_API = "https://api.poe.com/v1/chat/completions";

// 读取模型映射配置
let modelMapping: Record<string, string> = {};
let reverseModelMapping: Record<string, string> = {};

async function loadModelMapping() {
  try {
    const modelsText = await Deno.readTextFile("models.json");
    modelMapping = JSON.parse(modelsText);
    
    // 创建反向映射，支持用户使用目标模型名称
    reverseModelMapping = {};
    for (const [key, value] of Object.entries(modelMapping)) {
      reverseModelMapping[value] = key;
    }
    
    console.log(`已加载 ${Object.keys(modelMapping).length} 个模型映射`);
  } catch (error) {
    console.warn("无法加载 models.json，将使用空映射:", error.message);
    modelMapping = {};
    reverseModelMapping = {};
  }
}

// 模型名称映射函数
function mapModelName(inputModel: string): string {
  // 先检查直接映射
  if (modelMapping[inputModel]) {
    return modelMapping[inputModel];
  }
  
  // 再检查反向映射（用户可能直接使用目标模型名）
  if (reverseModelMapping[inputModel]) {
    return inputModel; // 已经是目标模型名，直接返回
  }
  
  // 如果都没找到，返回原始模型名
  return inputModel;
}

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // 只兼容 OpenAI 标准接口
  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    // 1. 解析 Authorization Header（和 OpenAI 保持一致）
    const auth = req.headers.get("authorization");
    let token = "";
    if (auth && auth.startsWith("Bearer ")) {
      token = auth.slice(7).trim();
    } else {
      return new Response(
        JSON.stringify({ error: { message: "Missing Bearer token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    // 2. 读取所有请求参数
    const reqBody = await req.json();
    
    // 3. 模型名称映射
    if (reqBody.model) {
      const originalModel = reqBody.model;
      const mappedModel = mapModelName(originalModel);
      reqBody.model = mappedModel;
      
      console.log(`模型映射: ${originalModel} -> ${mappedModel}`);
    }

    // 4. 构造目标请求（token 放 header）
    const headers = new Headers({
      ...req.headers,
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "host": new URL(UPSTREAM_API).host,
    });

    // 5. 处理流式（stream）与非流式
    const stream = reqBody.stream === true;

    // 6. 转发请求到目标大模型API
    const upstreamResp = await fetch(UPSTREAM_API, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
    });

    // 流式
    if (stream) {
      // 保证 header 兼容 SSE
      const r = new ReadableStream({
        async start(controller) {
          const reader = upstreamResp.body!.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        },
      });
      return new Response(r, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    } else {
      // 非流式直接原样返回
      const text = await upstreamResp.text();
      return new Response(text, {
        status: upstreamResp.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
  }

  // 添加模型列表接口
  if (req.method === "GET" && pathname === "/v1/models") {
    const models = Object.keys(modelMapping).concat(Object.keys(reverseModelMapping));
    const uniqueModels = [...new Set(models)];
    
    const modelList = {
      object: "list",
      data: uniqueModels.map(model => ({
        id: model,
        object: "model",
        created: Date.now(),
        owned_by: "proxy"
      }))
    };
    
    return new Response(JSON.stringify(modelList), {
      status: 200,
      headers: { 
        "content-type": "application/json",
        "access-control-allow-origin": "*"
      }
    });
  }

  // 健康检查 or 404
  return new Response(
    JSON.stringify({ 
      message: "OK, POST /v1/chat/completions", 
      models_loaded: Object.keys(modelMapping).length 
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// 启动服务前先加载模型映射
await loadModelMapping();

// 启动服务
serve(handle, { port: 8000 });
console.log("OpenAI兼容服务已启动: http://localhost:8000/v1/chat/completions");
console.log("模型列表接口: http://localhost:8000/v1/models");
