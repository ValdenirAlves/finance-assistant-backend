# PostgreSQL setup

Run commands from `backend/` using Node.js 24.21.0 and npm 11.x.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` for your PostgreSQL instance.
3. Create the empty `finance_assistant` database (or use your chosen database name).
4. Run `npm run prisma:deploy` to apply the committed migrations.
5. Run `npm run build` and `npm run start:dev`.

The application requires a reachable PostgreSQL database at startup. Build, unit
tests and scaffold e2e tests do not require PostgreSQL; the e2e tests replace the
Prisma service with a mock and do not verify database connectivity.

For subsequent schema changes, run `npm run prisma:migrate -- --name <name>`
against a development database. This command also needs permission to create a
shadow database, or a separately configured shadow database.

The initial migration is generated from an empty schema without connecting to a
database. Applying it and verifying live persistence require PostgreSQL.

`Expense.amount` uses PostgreSQL `DECIMAL(19,4)` and Prisma `Decimal`. Construct
monetary amounts from decimal strings and use Decimal operations; never convert
amounts to JavaScript `number` for arithmetic. Each expense retains its original
amount and ISO 4217 currency code. The required `Currency` enum supports `EUR`
and `BRL`; future DTO validation must enforce these supported codes as well.
Merchant is optional. Transaction and audit timestamps retain timezone-aware instants.

Never aggregate or compare amounts in different currencies without an explicit
conversion step. Until exchange-rate handling is implemented in a later milestone,
all totals must be grouped by currency. No conversion or aggregation is implemented yet.

The supported-currencies migration preserves existing amounts and currency codes.
If an existing expense has a code other than `EUR` or `BRL`, the migration fails
rather than silently changing financial data. Resolve such records explicitly
before applying it. The initial migration remains unchanged.

`PrismaModule` exports `PrismaService`. Feature modules needing persistence should
import `PrismaModule` and inject the service outside controllers. The service
connects on initialization and disconnects on shutdown.
