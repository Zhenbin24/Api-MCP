/** 30 个与官方一致的 MCP 工具定义（tools/list 返回体） */

const S = (props, required = []) => ({
  type: 'object',
  properties: props,
  ...(required.length ? { required } : {})
});
const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const anyObj = (description) => ({ type: 'object', ...(description ? { description } : {}) });

const INPUT_SCHEMA = {
  type: 'object',
  description: '可选参数覆盖，支持 query、path、headers、cookies、body、auth；参数字段必须已在接口定义中存在。',
  properties: {
    query: { type: 'object' },
    path: { type: 'object' },
    headers: { type: 'object' },
    cookies: { type: 'object' },
    body: {},
    auth: anyObj('可选。覆盖接口认证配置')
  }
};

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    step_id: str('保留或修改已有步骤时必传；新增步骤（包括相同接口再次加入）不要传'),
    target_id: str('当前项目中已定义的 HTTP 接口 target_id'),
    input: INPUT_SCHEMA,
    pre_script: str(
      '可选。发送请求前执行的 JS 前置脚本。用 apt.environment.set(key,value) 写环境变量、apt.globals.set(key,value) 写全局变量、console.log 打印日志；也可用 apt.setRequestHeader/setRequestQuery 改写本次请求。写回的变量后续步骤可用 {{变量名}} 引用，并在执行结果的「断言、日志与变量」中可见。'
    ),
    post_script: str(
      '可选。收到响应后执行的 JS 后置脚本。从响应提取字段：apt.response.json()/apt.response.text()，再用 apt.environment.set(key,value) 写入环境变量供后续步骤 {{变量名}} 引用。'
    )
  },
  required: ['target_id']
};

export const TOOLS = [
  {
    name: 'apipost_list_projects',
    description: '获取已授权访问的 API 项目清单（含影子工作区同步状态）。',
    inputSchema: S({})
  },
  {
    name: 'apipost_create_project',
    description:
      '在 API 单机版数据目录本地新建项目，并自动加入授权列表。新项目会自动拉取到影子工作区，可立刻继续同步接口、环境或创建执行计划。不会切换用户当前正在界面中使用的项目。',
    inputSchema: S(
      {
        name: str('项目名称，最多 64 个字符'),
        description: str('可选的项目说明，最多 1024 个字符'),
        storage_path: str('可选。本机绝对父目录；不传则使用 API 默认数据目录')
      },
      ['name']
    )
  },
  {
    name: 'apipost_list_apis',
    description: '获取指定项目中的目录、接口与文档清单，可按目录或关键词筛选。',
    inputSchema: S(
      {
        project_id: str(),
        parent_id: str('父目录 target_id，不传则返回全部'),
        keyword: str('按名称/URL/方法模糊搜索')
      },
      ['project_id']
    )
  },
  {
    name: 'apipost_get_api_detail',
    description:
      '获取某个 API 接口或文档的完整详情。返回中 pre_tasks / post_tasks 是该接口自带的前置/后置脚本：单接口执行时会自动运行；业务流执行会忽略它们，只执行业务流步骤自身的 pre_script / post_script。若要执行一个目录模块，请先创建或更新对应的执行计划，再执行该计划。',
    inputSchema: S({ project_id: str(), target_id: str() }, ['project_id', 'target_id'])
  },
  {
    name: 'apipost_sync_openapi',
    description:
      '将 OpenAPI 3.0 或 3.1 数据（接口与数据模型）同步到项目（可指定导入目录，默认根目录）。接口覆盖方式默认为 url_and_folder；clear 为清空后导入（指定目录时仅清空该目录下的内容、保留目录本身），请谨慎使用。',
    inputSchema: S(
      {
        project_id: str(),
        openapi: { description: 'OpenAPI 3 JSON 对象或 JSON 字符串' },
        folder_id: str('目标目录的 target_id（需为项目内已存在的目录），默认根目录'),
        api_cover_mode: {
          type: 'string',
          enum: ['url_and_folder', 'url', 'ignore', 'both', 'clear'],
          default: 'url_and_folder',
          description:
            '默认 url_and_folder，按方法、URL 和目录覆盖；url 按请求方法和 URL 覆盖；ignore 跳过相同方法和 URL；both 保留两份；clear 清空后导入（指定 folder_id 时只清空该目录下的内容、保留目录本身）。'
        },
        base_path: bool('是否把 servers[0].url 拼到 URL 前面'),
        host_path: bool('是否把 servers[0].url 作为完整 host 前缀'),
        api_scripts: arr(
          {
            type: 'object',
            properties: {
              method: str('HTTP 方法，如 POST/GET'),
              url: str('与 OpenAPI 中一致的路径'),
              pre_script: str('可选。发送前执行的 JS'),
              post_script: str('可选。收到响应后执行的 JS')
            },
            required: ['method', 'url']
          },
          '可选。按 method+url 给同步进来的接口附加前后置脚本。'
        )
      },
      ['project_id', 'openapi']
    )
  },
  {
    name: 'apipost_delete_apis',
    description: '显式删除指定的 API 接口。不会根据 OpenAPI 自动删除任何接口。删除目录会级联删除其下所有内容。',
    inputSchema: S(
      { project_id: str(), target_ids: arr(str()), confirm: bool('必须为 true 才会执行删除') },
      ['project_id', 'target_ids', 'confirm']
    )
  },
  {
    name: 'apipost_execute_api',
    description:
      '严格按 API 中已定义的接口、环境、鉴权、前后置脚本与断言执行一个 HTTP 接口。只能传 target_id 和已定义参数的覆盖值，不能传 URL 或 curl。执行完成后返回 run_id；使用 apipost_get_execution_result 获取完整详情。',
    inputSchema: S(
      {
        project_id: str(),
        target_id: str(),
        environment_id: str('可选，环境 ID；不传时使用当前环境'),
        input: INPUT_SCHEMA
      },
      ['project_id', 'target_id']
    )
  },
  {
    name: 'apipost_list_environments',
    description: '获取指定项目可用的环境及当前环境。创建或更新执行计划前，如需指定 environment_id，先调用本工具获取真实环境 ID。',
    inputSchema: S({ project_id: str() }, ['project_id'])
  },
  {
    name: 'apipost_switch_environment',
    description: '将指定项目当前使用的环境切换为 environment_id。执行计划已保存的 environment_id 不会被改动。',
    inputSchema: S({ project_id: str(), environment_id: str() }, ['project_id', 'environment_id'])
  },
  {
    name: 'apipost_create_environment',
    description: '在指定项目新建环境。base_url 可选，表示该环境默认服务的地址。',
    inputSchema: S({ project_id: str(), name: str(), base_url: str() }, ['project_id', 'name'])
  },
  {
    name: 'apipost_update_environment',
    description: '修改指定环境的名称和/或默认服务地址。仅传需要修改的字段。',
    inputSchema: S({ project_id: str(), environment_id: str(), name: str(), base_url: str() }, [
      'project_id',
      'environment_id'
    ])
  },
  {
    name: 'apipost_delete_environment',
    description: '删除指定环境。默认环境不可删除，必须显式传 confirm: true。',
    inputSchema: S(
      { project_id: str(), environment_id: str(), confirm: bool() },
      ['project_id', 'environment_id', 'confirm']
    )
  },
  {
    name: 'apipost_list_environment_servers',
    description: '查询项目的服务。传 environment_id 时返回该环境实际使用的服务地址；不传则只查询项目共享服务列表。',
    inputSchema: S({ project_id: str(), environment_id: str() }, ['project_id'])
  },
  {
    name: 'apipost_create_environment_server',
    description:
      '向项目新增一个共享服务。若同时传 environment_id 与 base_url，会为该环境设置该服务地址；其他环境地址保持为空。',
    inputSchema: S({ project_id: str(), name: str(), environment_id: str(), base_url: str() }, ['project_id', 'name'])
  },
  {
    name: 'apipost_update_environment_server',
    description: '修改共享服务名称，或指定某环境后修改该环境内的服务地址。修改 base_url 时必须同时传 environment_id。',
    inputSchema: S(
      { project_id: str(), server_id: str(), name: str(), environment_id: str(), base_url: str() },
      ['project_id', 'server_id']
    )
  },
  {
    name: 'apipost_delete_environment_server',
    description: '从项目所有环境中删除指定服务，必须显式传 confirm: true。',
    inputSchema: S({ project_id: str(), server_id: str(), confirm: bool() }, ['project_id', 'server_id', 'confirm'])
  },
  {
    name: 'apipost_get_environment_variables',
    description: '读取指定环境的变量，返回默认值 value 与当前运行时值 current_value。',
    inputSchema: S({ project_id: str(), environment_id: str() }, ['project_id', 'environment_id'])
  },
  {
    name: 'apipost_upsert_environment_variable',
    description:
      '新增或修改环境变量。仅传需要修改的 value、current_value、description；current_value 是当前运行时值，会被后续执行步骤引用。',
    inputSchema: S(
      {
        project_id: str(),
        environment_id: str(),
        key: str(),
        value: {},
        current_value: {},
        description: str()
      },
      ['project_id', 'environment_id', 'key']
    )
  },
  {
    name: 'apipost_delete_environment_variable',
    description: '删除指定环境变量的默认值与当前运行时值，必须显式传 confirm: true。',
    inputSchema: S(
      { project_id: str(), environment_id: str(), key: str(), confirm: bool() },
      ['project_id', 'environment_id', 'key', 'confirm']
    )
  },
  {
    name: 'apipost_get_global_variables',
    description: '读取项目全局变量，返回默认值 value 与当前运行时值 current_value。',
    inputSchema: S({ project_id: str() }, ['project_id'])
  },
  {
    name: 'apipost_upsert_global_variable',
    description: '新增或修改全局变量。仅传需要修改的 value、current_value、description。',
    inputSchema: S({ project_id: str(), key: str(), value: {}, current_value: {}, description: str() }, [
      'project_id',
      'key'
    ])
  },
  {
    name: 'apipost_delete_global_variable',
    description: '删除全局变量的默认值与当前运行时值，必须显式传 confirm: true。',
    inputSchema: S({ project_id: str(), key: str(), confirm: bool() }, ['project_id', 'key', 'confirm'])
  },
  {
    name: 'apipost_create_execution_flow',
    description:
      '向项目创建一个执行计划。每一步必须引用当前项目中已定义的 HTTP 接口 target_id；同一 target_id 可以出现多次，每次都是参数、认证、Cookie 与脚本独立的执行步骤。【强制】在构造 steps 之前，必须对每个 step 的 target_id 重新调用 apipost_get_api_detail 获取最新接口详情；禁止使用本次对话早期缓存的数据。新加入计划的接口会固化为独立步骤快照，之后 API 的修改不会自动改变该步骤。业务流会忽略接口自带 pre_tasks / post_tasks，只执行本步骤传入的 pre_script / post_script。跨步骤传值：可在任意步骤用 post_script 从响应提取字段写入环境变量（如 apt.environment.set("token", apt.response.json().token)），后续步骤的 input 里用 {{变量名}} 引用。',
    inputSchema: S(
      {
        project_id: str(),
        name: str('业务流程名称'),
        description: str('可选的流程说明'),
        environment_id: str('可选。计划固定使用的环境 ID；不传时使用当前环境'),
        steps: arr(STEP_SCHEMA, '按业务顺序排列的接口步骤')
      },
      ['project_id', 'name', 'steps']
    )
  },
  {
    name: 'apipost_update_execution_flow',
    description:
      '更新已有执行计划的名称、说明、环境或步骤。计划执行期间不能更新；【强制】先调用 apipost_get_execution_flow 获取当前计划完整详情。steps 传入后会完整替换原步骤：保留或修改已有步骤时必须带回其 step_id；要新增步骤（包括再次添加相同 target_id）则不要传 step_id。业务流会忽略接口自带 pre_tasks / post_tasks，只执行本步骤传入的 pre_script / post_script。',
    inputSchema: S(
      {
        project_id: str(),
        flow_id: str(),
        name: str('可选的新计划名称'),
        description: str('可选的新计划说明'),
        environment_id: str('可选。计划固定使用的环境 ID'),
        steps: arr(STEP_SCHEMA, '可选的新执行步骤，按业务顺序排列；传入后会完整替换原步骤')
      },
      ['project_id', 'flow_id']
    )
  },
  {
    name: 'apipost_list_execution_flows',
    description:
      '获取项目中的执行计划摘要（名称、环境、步骤数量、更新时间）。不返回步骤和接口快照；需要查看或修改某条计划时，必须再调用 apipost_get_execution_flow。',
    inputSchema: S({ project_id: str() }, ['project_id'])
  },
  {
    name: 'apipost_get_execution_flow',
    description:
      '获取一条执行计划的完整详情，包括步骤顺序、接口快照、参数覆盖、认证、Cookie 和步骤脚本。修改已有计划前，先调用此工具读取当前计划；再针对每个步骤调用 apipost_get_api_detail 获取最新 API 作为编排参考。',
    inputSchema: S({ project_id: str(), flow_id: str() }, ['project_id', 'flow_id'])
  },
  {
    name: 'apipost_delete_execution_flow',
    description: '删除指定执行计划，不会删除历史执行记录。计划执行中不可删除，必须显式传 confirm: true。',
    inputSchema: S({ project_id: str(), flow_id: str(), confirm: bool() }, ['project_id', 'flow_id', 'confirm'])
  },
  {
    name: 'apipost_execute_flow',
    description:
      '串行执行一个执行计划，严格使用计划中已保存的接口快照、顺序、鉴权、脚本和断言。默认使用计划已保存的环境；传入 environment_id 可仅对本次执行覆盖。执行时不会读取或同步 API 的后续修改。执行完成后返回 run_id。',
    inputSchema: S({ project_id: str(), flow_id: str(), environment_id: str('可选，仅对本次执行覆盖环境') }, [
      'project_id',
      'flow_id'
    ])
  },
  {
    name: 'apipost_list_execution_runs',
    description:
      '查询项目最近保留的执行历史摘要（最多 50 条，按最新优先）。可按执行范围、来源、状态或执行计划筛选；结果只含状态、耗时和失败步骤摘要，不含请求/响应详情。需要诊断某次执行时，再使用 apipost_get_execution_result 并传入 run_id。',
    inputSchema: S(
      {
        project_id: str(),
        scope: { type: 'string', enum: ['api', 'flow'], description: '可选，按单接口或执行计划筛选' },
        source: { type: 'string', enum: ['manual', 'mcp'], description: '可选，按人工或 AI 发起筛选' },
        status: { type: 'string', enum: ['passed', 'failed'], description: '可选，按执行结果筛选' },
        flow_id: str('可选，仅查询指定执行计划的记录'),
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '可选，返回条数，默认 20' }
      },
      ['project_id']
    )
  },
  {
    name: 'apipost_get_execution_result',
    description:
      '根据 run_id 获取一次执行的完整结果，包括每个接口的请求、响应、断言、脚本日志、提取变量，用于诊断失败步骤。可先用 apipost_list_execution_runs 查找目标 run_id。',
    inputSchema: S({ project_id: str(), run_id: str() }, ['project_id', 'run_id'])
  }
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}
