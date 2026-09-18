This sketch is in C++, not typescript, because I don't know how to express some of these ideas of translator objects in TypeScript, nor know how the input/output shapes would be expressed as keys or values in a JSON object that is loaded at runtime.  
But the basic pattern, expressed as pseudo-code, is:
```cpp
//outside the loop
translationMap = loadTranslationMap(jsonFileOnDisk);
//inside the loop
translateFunction = translationMap.get(currentBlock);
inputForNextBlock = translateFunction(outputOfCurrentBlock);
```

Note: this snippet does not compile.
```cpp

struct SkillInvocationArgs { /* ... */ };

template<typename InputShape, typename OutputShape>
struct BlockToBlockTranslatorBase {
    virtual ~BlockToBlockTranslatorBase() = default;
    virtual OutputShape mutateInput(const InputShape& input) = 0;
};

struct PreambleOutputShape { /* ... */ };
struct PlannerInputShape { /* ... */ };
/*
a concrete instance of the block-to-block translator base class.
This one is specifically for the Preamble script output, to feed into the PLAN_THE_TASK block's script. 
It consumes the output of the Preamble script.
It produces the input shape for the PLAN_THE_TASK script.
*/
struct PreamblePlannerTranslator : BlockToBlockTranslatorBase<PreambleOutputShape, PlannerInputShape> {
    PlannerInputShape mutateInput(const PreambleOutputShape& shapeToTranslate) override;
}

template<typename InputShape>
BlockToBlockTranslatorBase getTranslationObjectsFor(const InputShape& inputShape ){
    //a map that defines which Translator object to use for a given diagram block, so its output is correctly formatted reaches the next block in the diagram 
    static const std::map<BlockID, BlockToBlockTranslatorBase> translatorMap{
        { PreambleBlock::ID, PreamblePlannerTranslator },
        { PLAN_THE_TASK::ID, PlannerReviewTranslator }, 
        { CODEX_REVIEWS_THE_PLAN::ID, CodexReviewImplementerTranslator },
        //etc..
    };

    assert( translatorMap.contains(inputShape.blockId) );
    //returns an instance of the Block-to-block translator for this particular input shape
    return translatorMap.at(inputShape.blockId);
}

//helper function for translating the payload between blocks
template<typename TranslationType, typename Input>
function translate(TranslationType translator, Input whatToTranslate) {
    return translator.mutateInput(whatToTranslate);
}

//======================================================
struct ScriptOutputBase {
    virtual ScriptOutputBase() = default;
    /* ... */
};

template<typename ReturnType, typename ... Args>
struct BlockBase {
    std::function<ReturnType(Args...)> action;
};

struct PayloadBase { };

struct InvocationArgsBase {
    virtual ~InvocationArgsBase() = default;
    virtual BlockBase getBlock() = 0;
    virtual PayloadBase getPayload() = 0;
};

template<typename Input>
BlockBase getBlockFromRunStepInput(const Input& input ) {
    return input.getBlock();
}

template<typename Input>
PayloadBase getPayloadFrom(const Input& input) {
    return input.getPayload();
}

template<typename Block, typename Payload, typename Result>
Result executeBlock(const Block& block, const Payload& payload) {
    //unpackPayload is a magic function that converts payload into the argument list needed by the block's `action` function.
    return block.action( unpackPayload(payload)... ); 
}

template<typename InvocationArgsBase>
ScriptOutputBase runStepBlockLoop(const InvocationArgsBase& input) {
    while( true ) {
        //get the block script to invoke
        auto block = getBlockFromRunStepArgs(input); 
        //get the args to pass to that block
        auto payload = getPayloadFrom(input);
        //execute the block script.  this function is where the work that the block performs actually happens
        auto result = executeBlock(block, payload);
        //
        if( result.done )
            return result.payload; //must conform to the schema the workflow.js requires the agent() call to return
        //look up the translation shape from the block-to-block translation map
        auto translationJSON = getTranslationObjectsFor(input);
        //translate the result's payload into the shape the next block requires. 
        input = translate(translationJSON, result.payload);
    }
}

int main( /* argc, argv */ ) {
    auto input = parseInvocationArgs( argc, argv );
    std::cout << runStepBlockLoop(input) << std::endl;  //print out the result
    return 0;
}
```