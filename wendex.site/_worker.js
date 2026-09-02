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

function extractText(result) {
  if (!result) {
    return "";
  }

  if (typeof result.response === "string") {
    return result.response.trim();
  }

  if (typeof result.output_text === "string") {
    return result.output_text.trim();
  }

  if (typeof result.text === "string") {
    return result.text.trim();
  }

  if (Array.isArray(result.output)) {
    for (const item of result.output) {
      if (!Array.isArray(item?.content)) {
        continue;
      }

      for (const part of item.content) {
        if (
          typeof part?.text === "string" &&
          part.text.trim()
        ) {
          return part.text.trim();
        }
      }
    }
  }

  if (Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      const content = choice?.message?.content;

      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }

      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part?.text === "string" &&
            part.text.trim()
          ) {
            return part.text.trim();
          }
        }
      }
    }
  }

  return "";
}

function removeMarkdownFences(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
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
  if (!env?.AI) {
    return errorResponse(
      "Workers AI не подключён к Worker. Проверь binding AI.",
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

  /*
    Ограничение размера запроса.
    Не даём случайно отправить огромный файл.
  */
  if (imageDataUrl.length > 12_000_000) {
    return errorResponse(
      "Скриншот слишком большой.",
      413
    );
  }

  const systemPrompt = `
Ты — система распознавания предметов инвентаря игры.

Тебе передан скриншот инвентаря.

Нужно распознавать ТОЛЬКО следующие предметы:

${ALLOWED_ITEMS.map(
  item => `- ${item}`
).join("\n")}

СТРОГИЕ ПРАВИЛА:

1. Определи все видимые предметы из разрешённого списка.
2. Для каждого предмета определи число, указанное на его ячейке.
3. Если один и тот же предмет встречается несколько раз, сложи количества.
4. Игнорируй все предметы, которых нет в разрешённом списке.
5. Не придумывай отсутствующие предметы.
6. Не рассчитывай деньги.
7. Не меняй названия предметов.
8. Если количество невозможно уверенно определить, не добавляй такой предмет.
9. Особенно внимательно смотри на маленькие цифры возле иконок.
10. Верни ТОЛЬКО JSON без Markdown и без пояснений.

Формат ответа:

{
  "items": [
    {
      "name": "Название предмета",
      "quantity": 123,
      "confidence": 0.95
    }
  ]
}

confidence — число от 0 до 1.
`;

  /*
    Gemma 4 на Workers AI поддерживает vision.
    Изображение передаём как data URL.
  */
  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Распознай предметы на этом скриншоте инвентаря."
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
          JSON Mode поддерживается Workers AI.
          Схему дополнительно описываем в системном prompt,
          чтобы модель возвращала только нужную структуру.
        */
        response_format: {
          type: "json_object"
        },

        max_tokens: 1200,

        temperature: 0
      }
    );
  } catch (error) {
    console.error(
      "Workers AI error:",
      error
    );

    return errorResponse(
      "Ошибка Workers AI.",
      502,
      error?.message || String(error)
    );
  }

  /*
    Некоторые версии Workers AI могут вернуть
    результат в разных полях.
  */
  let outputText = extractText(aiResult);

  if (!outputText) {
    console.error(
      "Empty Workers AI response:",
      aiResult
    );

    return errorResponse(
      "Workers AI не вернул результат.",
      502
    );
  }

  outputText = removeMarkdownFences(
    outputText
  );

  let parsed;

  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    console.error(
      "Invalid JSON from Workers AI:",
      outputText
    );

    return errorResponse(
      "Workers AI вернул некорректный JSON.",
      502,
      outputText.slice(0, 1000)
    );
  }

  const items = cleanRecognition(
    parsed?.items
  );

  return jsonResponse({
    items
  });
}

export default {
  async fetch(request, env) {

    const url = new URL(
      request.url
    );

    /*
      Проверка Workers AI.
      Открой:
      /api/test-ai
    */
    if (
      url.pathname === "/api/test-ai" &&
      request.method === "GET"
    ) {

      if (!env?.AI) {
        return jsonResponse({
          AI: "НЕ ПОДКЛЮЧЕН"
        });
      }

      return jsonResponse({
        AI: "ПОДКЛЮЧЕН",
        model: MODEL
      });
    }

    /*
      Распознавание изображения.
    */
    if (
      url.pathname === "/api/recognize" &&
      request.method === "POST"
    ) {
      return recognizeImage(
        request,
        env
      );
    }

    /*
      Защита от GET-запроса к API.
    */
    if (
      url.pathname === "/api/recognize"
    ) {
      return jsonResponse(
        {
          error:
            "Для распознавания нужен POST-запрос с изображением."
        },
        405
      );
    }

    /*
      Отдаём index.html и остальные файлы.
    */
    if (env?.ASSETS) {
      return env.ASSETS.fetch(
        request
      );
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
