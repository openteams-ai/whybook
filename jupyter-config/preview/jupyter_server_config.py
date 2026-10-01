# The server of `jlpm preview:app`: a demo of the view for trusted people,
# reached through a Cloudflare tunnel to this machine. Nothing here is a
# security boundary against a hostile visitor; it keeps a visitor from
# deleting or changing something by accident.
c = get_config()  # noqa: F821

# No terminal: a visitor gets no shell on the machine.
c.ServerApp.terminals_enabled = False

c.ContentsManager.allow_hidden = True

# The demos only, not the checkout: a visitor cannot delete or edit the
# repository's files from the file browser. Deleted files go to the trash.
c.ServerApp.root_dir = "examples"
c.FileContentsManager.delete_to_trash = True

# The Extension Manager lists what is installed and installs nothing from
# PyPI. It can still disable an installed extension, for everyone on this
# server.
c.LabApp.extension_manager = "readonly"

# Only kernels that run no code outside a sandbox. In the sandboxed Python and
# R kernels (whybook/sandbox), code runs with the notebook's folder mounted and
# the rest of the file system read-only, without network. The plain Python
# and R kernels are neither listed nor added back.
c.KernelSpecManager.allowed_kernelspecs = {"python3-sandboxed", "r-sandboxed"}
c.KernelSpecManager.ensure_native_kernel = False
c.MappingKernelManager.default_kernel_name = "python3-sandboxed"

# The owner's Claude Code login answers the demo's AI requests: every answer
# a visitor asks for runs on it.
c.Whybook.claude_code_login = True

# Through the tunnel, the browser sends the tunnel's address as Origin. If the
# kernel does not connect (a 403 on /api/kernels/.../channels), set the
# tunnel's address here, for example:
# c.ServerApp.allow_origin = "https://demo.example.com"
