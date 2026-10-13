const MODEL = "@cf/google/gemma-4-26b-a4b-it";

const ALLOWED_ITEMS = [
  "Кофе",
  "Помидор",
  "Молоко",
  "Гипс",
  "Железо",
  "Реагенты",
  "Аммиак",
  "Остатки приборов шепота",
  "Отличная тушенка",
  "Газовый баллон",
  "Перчатки",
  "Чеснок",
  "Поташ",
  "Мясо шавки",
  "Мясо кабана",
  "Мясо хрюши"
];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(message, status = 500, details = null) {
  return jsonResponse(
    {
      error: message,
      ...(details ? { details: String(details) } : {})
    },
    status
  );
}

function cleanRecognition(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const merged = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const name = String(item.name || "").trim();

    if (!ALLOWED_ITEMS.includes(name)) {
      continue;
    }

    let quantity = Number(item.quantity);

    if (!Number.isFinite(quantity)) {
      continue;
    }

    quantity = Math.floor(quantity);

    if (quantity <= 0) {
      continue;
    }

    let confidence = Number(item.confidence);

    if (!Number.isFinite(confidence)) {
      confidence = 0;
    }

    confidence = Math.max(0, Math.min(1, confidence));

    if (!merged.has(name)) {
      merged.set(name, {
        name,
        quantity: 0,
        confidence: 0
      });
    }

    const current = merged.get(name);

    current.quantity += quantity;
    current.confidence = Math.max(
      current.confidence,
      confidence
    );
  }

  return Array.from(merged.values());
}

function removeMarkdown(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function recognizeImage(request, env) {
  if (!env?.AI) {
    return errorResponse(
      "Workers AI binding AI не подключён.",
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Некорректный JSON от сайта.",
      400
    );
  }

  const imageDataUrl = body?.image;

  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    return errorResponse(
      "Изображение не передано.",
      400
    );
  }

  if (imageDataUrl.length > 12_000_000) {
    return errorResponse(
      "Изображение слишком большое.",
      413
    );
  }

  const prompt = `
Ты распознаёшь инвентарь игры по изображению.

Разрешённые предметы:

${ALLOWED_ITEMS.map(x => "- " + x).join("\n")}

ЗАДАЧА:

1. Найди на скриншоте все предметы из списка.
2. Для каждого определи количество.
3. Если предмет встречается несколько раз, объедини количество.
4. Игнорируй все остальные предметы.
5. Не придумывай отсутствующие предметы.
6. Не рассчитывай цену.
7. Верни только JSON.

Формат:

{
  "items": [
    {
      "name": "Кофе",
      "quantity": 10,
      "confidence": 0.95
    }
  ]
}

confidence — число от 0 до 1.
`;

  const messages = [
    {
      role: "system",
      content: prompt
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Распознай предметы на этом скриншоте."
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl
          }
        }
      ]
    }
  ];

  let aiResult;

  try {
    aiResult = await env.AI.run(
      MODEL,
      {
        messages,

        /*
         * Отключаем reasoning, чтобы модель
         * возвращала именно полезный ответ.
         */
        chat_template_kwargs: {
          enable_thinking: false
        },

        temperature: 0,

        max_tokens: 1200,

        response_format: {
          type: "json_object"
        }
      }
    );
  } catch (error) {
    console.error(
      "Workers AI exception:",
      error
    );

    return errorResponse(
      "Ошибка при вызове Workers AI.",
      502,
      error?.message || String(error)
    );
  }

  /*
   * ДИАГНОСТИКА
   *
   * Пока НЕ пытаемся угадать,
   * где Cloudflare положил текст.
   *
   * Возвращаем реальный ответ модели.
   */
  return jsonResponse({
    debug: true,
    model: MODEL,
    raw: aiResult
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname === "/api/test-ai" &&
      request.method === "GET"
    ) {
      return jsonResponse({
        AI: env?.AI ? "ПОДКЛЮЧЕН" : "НЕ ПОДКЛЮЧЕН",
        model: MODEL
      });
    }

    if (
      url.pathname === "/api/recognize" &&
      request.method === "POST"
    ) {
      return recognizeImage(request, env);
    }

    if (url.pathname === "/api/recognize") {
      return errorResponse(
        "Для распознавания используется POST.",
        405
      );
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ASSETS binding не настроен.",
      {
        status: 500,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};
