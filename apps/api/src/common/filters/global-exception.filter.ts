import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = '服务器内部错误';
    let code: string | undefined;
    const isProd = process.env.NODE_ENV === 'production';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const obj = body as { message?: string | string[]; error?: string };
        message = obj.message ?? exception.message;
        code = obj.error;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = '资源已存在';
        code = 'unique_violation';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = '资源不存在';
        code = 'not_found';
      } else {
        status = HttpStatus.BAD_REQUEST;
        code = exception.code;
        // Prisma error text can leak schema/column internals — keep it in the
        // logs, return a generic message to clients in production.
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
        message = isProd
          ? '数据库操作失败'
          : (exception.message.split('\n').pop() ?? '数据库操作失败');
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
      // Never surface raw internal error messages to clients in production.
      message = isProd ? '服务器内部错误' : exception.message;
    }

    res.status(status).json({
      statusCode: status,
      code,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
