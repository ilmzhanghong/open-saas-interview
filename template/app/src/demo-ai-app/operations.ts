import OpenAI from "openai";
import type { GptResponse, Task } from "wasp/entities";
import { env, HttpError, prisma } from "wasp/server";
import type {
  CreateTask,
  DeleteTask,
  GenerateGptResponse,
  GetAllTasksByUser,
  GetGptResponses,
  UpdateTask,
} from "wasp/server/operations";
import * as z from "zod";
import { createProtectionDb } from "../ai-protection/db";
import { ProtectionError } from "../ai-protection/errors";
import { createRateLimitStore } from "../ai-protection/rate-limit";
import { protectAiOperation } from "../ai-protection/protect";
import { ensureArgsSchemaOrThrowHttpError } from "../server/validation";
import { GeneratedSchedule, generatedScheduleSchema } from "./schedule";

const openAi = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const rateLimiter = createRateLimitStore(
  env.RATE_LIMIT_STORE,
  prisma.rateLimitCounter,
);

//#region Actions
const generateGptResponseInputSchema = z.object({
  hours: z.number(),
});

type GenerateGptResponseInput = z.infer<typeof generateGptResponseInputSchema>;

export const generateGptResponse: GenerateGptResponse<
  GenerateGptResponseInput,
  GeneratedSchedule
> = async (rawArgs, context) => {
  if (!context.user) {
    throw new HttpError(
      401,
      "Only authenticated users are allowed to perform this operation",
    );
  }

  const { hours } = ensureArgsSchemaOrThrowHttpError(
    generateGptResponseInputSchema,
    rawArgs,
  );
  const userId = context.user.id;
  const tasks = await context.entities.Task.findMany({
    where: {
      user: {
        id: userId,
      },
    },
  });

  // Deterministic serialization: stable ordering so identical requests
  // produce identical dedupe keys.
  const parsedTasks = tasks
    .map(({ description, time }) => ({ description, time }))
    .sort((a, b) => a.description.localeCompare(b.description));

  try {
    return await protectAiOperation(
      {
        operationType: "generateSchedule",
        quotaCost: 1,
        rateLimit: { windowMs: 60_000, max: 10 },
        dedupeTtlMs: 600_000,
        inputToDedupeKey: () => JSON.stringify({ hours, tasks: parsedTasks }),
        inputToLogText: () => JSON.stringify({ hours, tasks: parsedTasks }),
      },
      { db: createProtectionDb(context.entities), rateLimiter },
      userId,
      rawArgs,
      async () => {
        console.log("Calling open AI api");
        const generatedSchedule = await generateScheduleWithGpt(tasks, hours);
        if (generatedSchedule === null) {
          throw new Error("Encountered a problem in communication with OpenAI");
        }

        await context.entities.GptResponse.create({
          data: {
            user: { connect: { id: userId } },
            content: JSON.stringify(generatedSchedule),
          },
        });

        return generatedSchedule;
      },
    );
  } catch (e) {
    if (e instanceof ProtectionError) {
      throw new HttpError(e.statusCode, e.message, e.data);
    }
    throw e;
  }
};

const createTaskInputSchema = z.object({
  description: z.string().nonempty(),
});

type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const createTask: CreateTask<CreateTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { description } = ensureArgsSchemaOrThrowHttpError(
    createTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.create({
    data: {
      description,
      user: { connect: { id: context.user.id } },
    },
  });

  return task;
};

const updateTaskInputSchema = z.object({
  id: z.string().nonempty(),
  isDone: z.boolean().optional(),
  time: z.string().optional(),
});

type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const updateTask: UpdateTask<UpdateTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { id, isDone, time } = ensureArgsSchemaOrThrowHttpError(
    updateTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.update({
    where: {
      id,
      user: {
        id: context.user.id,
      },
    },
    data: {
      isDone,
      time,
    },
  });

  return task;
};

const deleteTaskInputSchema = z.object({
  id: z.string().nonempty(),
});

type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;

export const deleteTask: DeleteTask<DeleteTaskInput, Task> = async (
  rawArgs,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }

  const { id } = ensureArgsSchemaOrThrowHttpError(
    deleteTaskInputSchema,
    rawArgs,
  );

  const task = await context.entities.Task.delete({
    where: {
      id,
      user: {
        id: context.user.id,
      },
    },
  });

  return task;
};
//#endregion

//#region Queries
export const getGptResponses: GetGptResponses<void, GptResponse[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.GptResponse.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
  });
};

export const getAllTasksByUser: GetAllTasksByUser<void, Task[]> = async (
  _args,
  context,
) => {
  if (!context.user) {
    throw new HttpError(401);
  }
  return context.entities.Task.findMany({
    where: {
      user: {
        id: context.user.id,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
};
//#endregion

async function generateScheduleWithGpt(
  tasks: Task[],
  hours: number,
): Promise<GeneratedSchedule | null> {
  const parsedTasks = tasks.map(({ description, time }) => ({
    description,
    time,
  }));

  const completion = await openAi.chat.completions.create({
    model: "gpt-3.5-turbo", // you can use any model here, e.g. 'gpt-3.5-turbo', 'gpt-4', etc.
    messages: [
      {
        role: "system",
        content:
          "you are an expert daily planner. you will be given a list of main tasks and an estimated time to complete each task. You will also receive the total amount of hours to be worked that day. Your job is to return a detailed plan of how to achieve those tasks by breaking each task down into at least 3 subtasks each. MAKE SURE TO ALWAYS CREATE AT LEAST 3 SUBTASKS FOR EACH MAIN TASK PROVIDED BY THE USER! YOU WILL BE REWARDED IF YOU DO.",
      },
      {
        role: "user",
        content: `I will work ${hours} hours today. Here are the tasks I have to complete: ${JSON.stringify(
          parsedTasks,
        )}. Please help me plan my day by breaking the tasks down into actionable subtasks with time and priority status.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "parseTodaysSchedule",
          description: "parses the days tasks and returns a schedule",
          parameters: z.toJSONSchema(generatedScheduleSchema),
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: {
        name: "parseTodaysSchedule",
      },
    },
    temperature: 1,
  });

  const gptResponse = completion.choices[0].message.tool_calls?.find(
    (call) => call.type === "function",
  )?.function.arguments;

  return gptResponse !== undefined
    ? generatedScheduleSchema.parse(JSON.parse(gptResponse))
    : null;
}
