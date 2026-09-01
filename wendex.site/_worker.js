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
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(message, status = 500, details = null) {
  const body = {
    error: message
  };

  if (details) {
    body.details = String(details);
  }

  return jsonResponse(body, status);
}

function extractOutputText(result) {
  if (
    result &&
    typeof result.output_text === "string" &&
    result.output_text.trim()
  ) {
    return result.output_text.trim();
  }

  if (!Array.isArray(result?.output)) {
    return "";
  }

  for (const outputItem of result.output) {
    if (!Array.isArray(outputItem?.content)) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (
        contentItem?.type === "output_text" &&
        typeof contentItem.text === "string" &&
        contentItem.text.trim()
      ) {
        return contentItem.text.trim();
      }
    }
  }

  return "";
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

    quantity = Math.max(0, Math.floor(quantity));

    if (quantity === 0) {
      continue;
    }

    let confidence = Number(item.confidence);

    if (!Number.isFinite(confidence)) {
      confidence = 0;
    }

    confidence = Math.max(
      0,
      Math.min(1, confidence)
    );

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

async function recognizeImage(request, env) {
  if (!env.OPENAI_API_KEY) {
    return errorResponse(
      "OPENAI_API_KEY не настроен в Cloudflare.",
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      "Сервер получил некорректный JSON.",
      400
    );
  }

  const imageDataUrl = body?.image;

  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/")
  ) {
    return errorResponse(
      "Изображение не передано или имеет неверный формат.",
      400
    );
  }

  const prompt = `
Ты распознаёшь инвентарь на скриншоте игры.

РАЗРЕШЁННЫЙ СПИСОК ПРЕДМЕТОВ:
${ALLOWED_ITEMS.map(item => "- " + item).join("\n")}

Твоя задача:
1. Найти на изображении все предметы из разрешённого списка.
2. Определить количество каждого предмета.
3. Если один и тот же предмет встречается несколько раз, объединить его количество.
4. Игнорировать любые предметы, которых нет в разрешённом списке.
5. Ничего не придумывать.
6. Не считать стоимость.
7. Не объяснять результат.
8. Вернуть только JSON, соответствующий заданной схеме.

Особое внимание уделяй:
- маленьким иконкам;
- цифрам количества;
- предметам, расположенным в разных местах изображения;
- повторяющимся предметам.

Если предмет виден, но количество определить невозможно, не добавляй его.
`;

  const openaiPayload = {
    model: "gpt-5",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          },
          {
            type: "input_image",
            image_url: imageDataUrl,
            detail: "high"
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "inventory_recognition",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    enum: ALLOWED_ITEMS
                  },
                  quantity: {
                    type: "integer",
                    minimum: 0
                  },
                  confidence: {
                    type: "number",
                    minimum: 0,
                    maximum: 1
                  }
                },
                required: [
                  "name",
                  "quantity",
                  "confidence"
                ]
              }
            }
          },
          required: ["items"]
        }
      }
    }
  };

  let openaiResponse;

  try {
    openaiResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(openaiPayload)
      }
    );
  } catch (networkError) {
    return errorResponse(
      "Не удалось связаться с OpenAI API.",
      502,
      networkError?.message
    );
  }

  const rawText = await openaiResponse.text();

  if (!openaiResponse.ok) {
    let details = rawText;

    try {
      const parsed = JSON.parse(rawText);

      details =
        parsed?.error?.message ||
        parsed?.error?.type ||
        rawText;
    } catch {
      // Оставляем исходный ответ.
    }

    return errorResponse(
      "OpenAI API вернул ошибку.",
      openaiResponse.status,
      details
    );
  }

  if (!rawText.trim()) {
    return errorResponse(
      "OpenAI API вернул пустой ответ.",
      502
    );
  }

  let result;

  try {
    result = JSON.parse(rawText);
  } catch {
    return errorResponse(
      "OpenAI API вернул некорректный JSON.",
      502,
      rawText.slice(0, 500)
    );
  }

  const outputText = extractOutputText(result);

  if (!outputText) {
    return errorResponse(
      "OpenAI не вернул результат распознавания.",
      502
    );
  }

  let parsedOutput;

  try {
    parsedOutput = JSON.parse(outputText);
  } catch {
    return errorResponse(
      "Результат распознавания оказался некорректным JSON.",
      502,
      outputText.slice(0, 500)
    );
  }

  const items = cleanRecognition(
    parsedOutput?.items
  );

  return jsonResponse({
    items
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API распознавания
    if (
      url.pathname === "/api/recognize" &&
      request.method === "POST"
    ) {
      return recognizeImage(request, env);
    }

    // Явно отвечаем на GET /api/recognize
    if (url.pathname === "/api/recognize") {
      return jsonResponse(
        {
          error: "Используй POST /api/recognize"
        },
        405
      );
    }

    // Всё остальное отдаём как обычные файлы сайта.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ASSETS binding не настроен.",
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};