const CliSignatureParser = require('./CliMetadata').CliSignatureParser;
const ExecuteClrInstruction = require('./ExecuteClrInstruction');

function ThreadExecute() {
    var result;
    do {
        var frame = this.callStack[this.callStack.length - 1];
        var clrData = frame.callingAssembly.clrData;
        switch (frame.state) {
            case 0: // initialize frame
                frame.previousStackLength = this.stack.length;
                frame.thread = this;
                switch (frame.method >> 24) {
                    case 0x06: // MethodDef
                        frame.executingAssembly = frame.callingAssembly;
                        frame.methodBody = clrData.getMethodBody(frame.method & 0xFFFFFF);
                        frame.state = 1;
                        break;
                    case 0x0A: // MemberRef
                        var memberRef = clrData.metadataTables._MemberRef[frame.method & 0xFFFFFF];
                        var signature = CliSignatureParser.parseMethodDefSig(memberRef.signature.createReader());

                        switch (memberRef.classRef.table) {
                            case 0x01: // TypeRef
                                var typeRef = memberRef.classRef.getItem();
                                switch (typeRef.resolutionScope.table) {
                                    case 0x23: // AssemblyRef
                                        var assemblyRef = clrData.metadataTables._AssemblyRef[typeRef.resolutionScope.index];
                                        var assemblyName = assemblyRef.name.toLowerCase();

                                        if (this.appDomain.assemblies[assemblyName] != null) {
                                            frame.state = 2;
                                            this.appDomain.loadAssembly(assemblyRef.name, function (a) {
                                                frame.executingAssembly = a;
                                                frame.state = 3;
                                            });
                                            return false;
                                        } else {
                                            frame.executingAssembly = this.appDomain.assemblies[assemblyName];
                                            frame.state = 3;
                                        }
                                        break;
                                    default:
                                        throw "Invalid method class assembly ref";
                                }
                                break;
                            default:
                                throw "Invalid method class ref";
                        }
                    case 0x2B: // MethodSpec
                    default:
                        throw "Invalid method token";
                }
                result = true;
                break;
            case 1:
                // method body execution setup
                frame.instructionPointer = 0;
                var methodDefSignature = frame.methodBody.methodDef.signature;
                var localVarSigTok = frame.methodBody.localVarSigTok;
                frame.signature = CliSignatureParser.parseMethodDefSig(methodDefSignature.createReader());
                frame.state = 5;
                frame.argumentsCount = getMethodArgumentsInStack(frame.signature);
                frame.arguments = [];

                var argumentValues = this.stack.splice(this.stack.length - frame.argumentsCount, frame.argumentsCount);
                for (var n = 0; n < frame.argumentsCount; ++n) {
                    var typeMeta = frame.signature.Params[n].Type;

                    // TODO: Rewrite in reasonable style. There should be no switches with these hard-coded values.
                    if (typeMeta.size) {
                        frame.arguments[n] = this.appDomain.createValue(1, typeMeta);
                        frame.arguments[n].Set(argumentValues[n]);
                    } else {
                        frame.arguments[n] = argumentValues[n];
                    }
                }

                if (localVarSigTok != undefined && localVarSigTok != 0) {
                    frame.locals = [];
                    if (frame.methodBody.initLocals) {
                        var standAloneSigRow = clrData.metadataTables._StandAloneSig[localVarSigTok & 0x00FFFFFF];
                        if (standAloneSigRow) {
                            frame.localsSignature = CliSignatureParser.parseLocalVarSig(standAloneSigRow.createReader());
                            frame.locals.length = frame.localsSignature.Count;
                            for (var n = 0; n < frame.locals.length; ++n) {
                                var signature = frame.localsSignature.Locals[n];
                                if (signature.size) {
                                    // We have size info, so reserve new block of memory and initialize it with zeros.
                                    frame.locals[n] = this.appDomain.createValue(1, signature);
                                } else {
                                    // No size info available, looks like some composite tyle e.g. an array 
                                    //   will be initiaized manually
                                    frame.locals[n] = { signature : signature };
                                }
                            }
                        }
                        // console.log(frame);
                    }
                }
                result = true;
                break;
            case 2:
                // wait for assembly... do nothing
                break;
            case 3:
                // assembly set
                if (frame.executingAssembly.nativeLib != undefined) {
                    var memberRef = clrData.metadataTables._MemberRef[frame.method & 0xFFFFFF];
                    var typeRef = memberRef.classRef.getItem();

                    frame.nativeCall = frame.executingAssembly.nativeLib.createCall(typeRef, memberRef);
                    frame.state = 4;

                    var memberRefSignature = memberRef.signature;
                    frame.signature = CliSignatureParser.parseMethodDefSig(memberRefSignature.createReader());
                    frame.argumentsCount = getMethodArgumentsInStack(frame.signature);
                } else {
                    throw "TODO: find method and class"
                }
                result = true;
                break;
            case 4:
                // native method execution loop
                result = frame.nativeCall.call(frame.executingAssembly.nativeLib, this);
                if (result) {
                    frame.state = 6;
                }
                break;
            case 5:
                // method execution
                result = ExecuteClrInstruction(this);
                break;
            case 6:
                if (frame.locals) {
                    var mem = this.appDomain.memory;
                    // Loop through locals array and mark the corresponding memory blocks as unused
                    for (var n = 0; n < frame.locals.length; ++n) {
                        if (frame.locals[n].reference) {
                            mem.free(frame.locals[n].reference);
                        }
                    }
                }
                if (frame.arguments) {
                    var mem = this.appDomain.memory;
                    // Loop through arguments array and mark the corresponding memory blocks as unused
                    for (var n = 0; n < frame.arguments.length; ++n) {
                        if (frame.arguments[n].reference) {
                            mem.free(frame.arguments[n].reference);
                        }
                    }
                }
                this.callStack.pop();
                result = true;
                break;
        }
        if (this.callStack.length == 0) break;
    } while (result);
    return result; // active

    function getMethodArgumentsInStack(signature) {
        var argumentsCount = signature.ParamCount;
        if (signature.HASTHIS != undefined)++argumentsCount;
        return argumentsCount;
    }
}

module.exports = ThreadExecute;
