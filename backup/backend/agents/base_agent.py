from abc import ABC , abstractmethod

class BaseAgent(ABC):

    def __init__(
        self,
        llm,
        tools=None,
        memory=None
    ):  
        self.llm = llm
        self.tools = tools or []
        self.memory = memory


    @abstractmethod
    async def run(self,input):
        pass
    