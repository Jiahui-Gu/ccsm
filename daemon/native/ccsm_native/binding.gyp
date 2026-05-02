{
  # ccsm_native — in-tree N-API helper for the CCSM daemon.
  #
  # Spec:
  #   docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
  #     §3.5.1.1   "Win JobObject wiring (data layer)"
  #     §3.5.1.1.a "Native binding swap interface (lockin-P0-2)"
  #     §3.5.1.2   "POSIX process group + SIGCHLD wiring (data layer)"
  #     §3.5.1.6   "Win named-pipe ACL hardening"
  #   docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md
  #     §11.1     "rebuild-native-for-node.cjs ... ccsm_native"
  #     §11.4     "ccsm_native.node ships + signs"
  #
  # One single .node carrying five export surfaces (winjob, pipeAcl,
  # pdeathsig, peerCred, sigchld). Per-platform translation units stub
  # the surfaces that are not native to that OS by throwing an Error
  # carrying `code: 'ENOSYS'` so the JS layer's "MUST throw on the
  # wrong platform" contract is honoured.
  #
  # NAPI version pin: NAPI 8 covers Node 16.6+ / Electron 17+. We are
  # explicit about it so a future Node target bump (currently
  # daemon/.nvmrc = 22.11.0) does not silently change ABI assumptions.
  'targets': [
    {
      'target_name': 'ccsm_native',
      'sources': [
        'src/ccsm_native.cc',
      ],
      'include_dirs': [
        "<!(node -p \"require('node-addon-api').include_dir\")",
      ],
      'defines': [
        # node-addon-api: opt out of C++ exceptions; we surface errors
        # via napi_throw_error so the dlopen path stays exception-free
        # regardless of the host's compile flags.
        'NAPI_DISABLE_CPP_EXCEPTIONS',
        'NODE_ADDON_API_DISABLE_DEPRECATED',
        'NAPI_VERSION=8',
      ],
      'cflags!': ['-fno-exceptions'],
      'cflags_cc!': ['-fno-exceptions'],
      'msvs_settings': {
        'VCCLCompilerTool': {
          'ExceptionHandling': 0,
          'AdditionalOptions': ['/utf-8'],
        },
      },
      'conditions': [
        ['OS=="win"', {
          'sources': [
            'src/winjob_win.cc',
            'src/pipeacl_win.cc',
            'src/peercred_win.cc',
            'src/pdeathsig_stub.cc',
            'src/sigchld_stub.cc',
          ],
          'libraries': [
            '-lAdvapi32.lib',
            '-lKernel32.lib',
          ],
          'defines': [
            '_HAS_EXCEPTIONS=0',
            'WIN32_LEAN_AND_MEAN',
            'NOMINMAX',
            'UNICODE',
            '_UNICODE',
          ],
        }],
        ['OS=="linux"', {
          'sources': [
            'src/winjob_stub.cc',
            'src/pipeacl_stub.cc',
            'src/peercred_linux.cc',
            'src/pdeathsig_linux.cc',
            'src/sigchld_unix.cc',
          ],
          'cflags_cc': ['-fexceptions', '-std=c++17'],
        }],
        ['OS=="mac"', {
          'sources': [
            'src/winjob_stub.cc',
            'src/pipeacl_stub.cc',
            'src/peercred_darwin.cc',
            'src/pdeathsig_stub.cc',
            'src/sigchld_unix.cc',
          ],
          'xcode_settings': {
            'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
            'CLANG_CXX_LIBRARY': 'libc++',
            'CLANG_CXX_LANGUAGE_STANDARD': 'c++17',
            'MACOSX_DEPLOYMENT_TARGET': '11.0',
          },
        }],
      ],
    },
  ],
}
