/** Native image/window helpers do not need AI credentials from dotenv or the shell. */
export function nativeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: source.SystemRoot || source.SYSTEMROOT || source.WINDIR || 'C:\\Windows'
  }
  for (const name of ['WINDIR', 'TEMP', 'TMP']) {
    if (source[name]) environment[name] = source[name]
  }
  return environment
}
